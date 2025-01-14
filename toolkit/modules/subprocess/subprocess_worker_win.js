/* -*- Mode: indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set sts=2 sw=2 et tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

/* exported Process */
/* globals BaseProcess, BasePipe, win32 */

importScripts("resource://gre/modules/subprocess/subprocess_shared.js",
              "resource://gre/modules/subprocess/subprocess_shared_win.js",
              "resource://gre/modules/subprocess/subprocess_worker_common.js");

const POLL_INTERVAL = 50;
const POLL_TIMEOUT = 0;

// The exit code that we send when we forcibly terminate a process.
const TERMINATE_EXIT_CODE = 0x7f;

let io;

let nextPipeId = 0;

class Pipe extends BasePipe {
  constructor(process, origHandle) {
    super();

    let handle = win32.HANDLE();

    let curProc = libc.GetCurrentProcess();
    libc.DuplicateHandle(curProc, origHandle, curProc, handle.address(),
                         0, false /* inheritable */, win32.DUPLICATE_SAME_ACCESS);

    origHandle.dispose();

    this.id = nextPipeId++;
    this.process = process;

    this.handle = win32.Handle(handle);

    let event = libc.CreateEventW(null, false, false, null);

    this.overlapped = win32.OVERLAPPED();
    this.overlapped.hEvent = event;

    this._event = win32.Handle(event);

    this.buffer = null;
  }

  get event() {
    if (this.pending.length) {
      return this._event;
    }
    return null;
  }

  maybeClose() {}

  /**
   * Closes the file handle.
   *
   * @param {boolean} [force=false]
   *        If true, the file handle is closed immediately. If false, the
   *        file handle is closed after all current pending IO operations
   *        have completed.
   *
   * @returns {Promise<void>}
   *          Resolves when the file handle has been closed.
   */
  close(force = false) {
    if (!force && this.pending.length) {
      this.closing = true;
      return this.closedPromise;
    }

    for (let {reject} of this.pending) {
      let error = new Error("File closed");
      error.errorCode = SubprocessConstants.ERROR_END_OF_FILE;
      reject(error);
    }
    this.pending.length = 0;

    this.buffer = null;

    if (!this.closed) {
      this.handle.dispose();
      this._event.dispose();

      io.pipes.delete(this.id);

      this.handle = null;
      this.closed = true;
      this.resolveClosed();

      io.updatePollEvents();
    }
    return this.closedPromise;
  }

  /**
   * Called when an error occurred while attempting an IO operation on our file
   * handle.
   */
  onError() {
    this.close(true);
  }
}

class InputPipe extends Pipe {
  /**
   * Queues the next chunk of data to be read from the pipe if, and only if,
   * there is no IO operation currently pending.
   */
  readNext() {
    if (this.buffer === null) {
      this.readBuffer(this.pending[0].length);
    }
  }

  /**
   * Closes the pipe if there is a pending read operation with no more
   * buffered data to be read.
   */
  maybeClose() {
    if (this.buffer) {
      let read = win32.DWORD();

      let ok = libc.GetOverlappedResult(
        this.handle, this.overlapped.address(),
        read.address(), false);

      if (!ok) {
        this.onError();
      }
    }
  }

  /**
   * Asynchronously reads at most `length` bytes of binary data from the file
   * descriptor into an ArrayBuffer of the same size. Returns a promise which
   * resolves when the operation is complete.
   *
   * @param {integer} length
   *        The number of bytes to read.
   *
   * @returns {Promise<ArrayBuffer>}
   */
  read(length) {
    if (this.closing || this.closed) {
      throw new Error("Attempt to read from closed pipe");
    }

    return new Promise((resolve, reject) => {
      this.pending.push({resolve, reject, length});
      this.readNext();
    });
  }

  /**
   * Initializes an overlapped IO read operation to read exactly `count` bytes
   * into a new ArrayBuffer, which is stored in the `buffer` property until the
   * operation completes.
   *
   * @param {integer} count
   *        The number of bytes to read.
   */
  readBuffer(count) {
    this.buffer = new ArrayBuffer(count);

    let ok = libc.ReadFile(this.handle, this.buffer, count,
                           null, this.overlapped.address());

    if (!ok && (!this.process.handle || libc.winLastError)) {
      this.onError();
    } else {
      io.updatePollEvents();
    }
  }

  /**
   * Called when our pending overlapped IO operation has completed, whether
   * successfully or in failure.
   */
  onReady() {
    let read = win32.DWORD();

    let ok = libc.GetOverlappedResult(
      this.handle, this.overlapped.address(),
      read.address(), false);

    read = read.value;

    if (!ok) {
      this.onError();
    } else if (read > 0) {
      let buffer = this.buffer;
      this.buffer = null;

      let {resolve} = this.shiftPending();

      if (read == buffer.byteLength) {
        resolve(buffer);
      } else {
        resolve(ArrayBuffer.transfer(buffer, read));
      }

      if (this.pending.length) {
        this.readNext();
      } else {
        io.updatePollEvents();
      }
    }
  }
}

class OutputPipe extends Pipe {
  /**
   * Queues the next chunk of data to be written to the pipe if, and only if,
   * there is no IO operation currently pending.
   */
  writeNext() {
    if (this.buffer === null) {
      this.writeBuffer(this.pending[0].buffer);
    }
  }

  /**
   * Asynchronously writes the given buffer to our file descriptor, and returns
   * a promise which resolves when the operation is complete.
   *
   * @param {ArrayBuffer} buffer
   *        The buffer to write.
   *
   * @returns {Promise<integer>}
   *          Resolves to the number of bytes written when the operation is
   *          complete.
   */
  write(buffer) {
    if (this.closing || this.closed) {
      throw new Error("Attempt to write to closed pipe");
    }

    return new Promise((resolve, reject) => {
      this.pending.push({resolve, reject, buffer});
      this.writeNext();
    });
  }

  /**
   * Initializes an overapped IO read operation to write the data in `buffer` to
   * our file descriptor.
   *
   * @param {ArrayBuffer} buffer
   *        The buffer to write.
   */
  writeBuffer(buffer) {
    this.buffer = buffer;

    let ok = libc.WriteFile(this.handle, buffer, buffer.byteLength,
                            null, this.overlapped.address());

    if (!ok && libc.winLastError) {
      this.onError();
    } else {
      io.updatePollEvents();
    }
  }

  /**
   * Called when our pending overlapped IO operation has completed, whether
   * successfully or in failure.
   */
  onReady() {
    let written = win32.DWORD();

    let ok = libc.GetOverlappedResult(
      this.handle, this.overlapped.address(),
      written.address(), false);

    written = written.value;

    if (!ok || written != this.buffer.byteLength) {
      this.onError();
    } else if (written > 0) {
      let {resolve} = this.shiftPending();

      this.buffer = null;
      resolve(written);

      if (this.pending.length) {
        this.writeNext();
      } else {
        io.updatePollEvents();
      }
    }
  }
}

class Process extends BaseProcess {
  constructor(...args) {
    super(...args);

    this.killed = false;
  }

  /**
   * Returns our process handle for use as an event in a WaitForMultipleObjects
   * call.
   */
  get event() {
    return this.handle;
  }

  /**
   * Forcibly terminates the process.
   */
  kill() {
    this.killed = true;
    libc.TerminateProcess(this.handle, TERMINATE_EXIT_CODE);
  }

  /**
   * Initializes the IO pipes for use as standard input, output, and error
   * descriptors in the spawned process.
   *
   * @returns {win32.Handle[]}
   *          The array of file handles belonging to the spawned process.
   */
  initPipes({stderr}) {
    let our_pipes = [];
    let their_pipes = [];

    let secAttr = new win32.SECURITY_ATTRIBUTES();
    secAttr.nLength = win32.SECURITY_ATTRIBUTES.size;
    secAttr.bInheritHandle = true;

    let pipe = input => {
      if (input) {
        let handles = win32.createPipe(secAttr, win32.FILE_FLAG_OVERLAPPED);
        our_pipes.push(new InputPipe(this, handles[0]));
        return handles[1];
      } else {
        let handles = win32.createPipe(secAttr, 0, win32.FILE_FLAG_OVERLAPPED);
        our_pipes.push(new OutputPipe(this, handles[1]));
        return handles[0];
      }
    };

    their_pipes[0] = pipe(false);
    their_pipes[1] = pipe(true);

    if (stderr == "pipe") {
      their_pipes[2] = pipe(true);
    } else {
      let srcHandle;
      if (stderr == "stdout") {
        srcHandle = their_pipes[1];
      } else {
        srcHandle = libc.GetStdHandle(win32.STD_ERROR_HANDLE);
      }

      let handle = win32.HANDLE();

      let curProc = libc.GetCurrentProcess();
      let ok = libc.DuplicateHandle(curProc, srcHandle, curProc, handle.address(),
                                    0, true /* inheritable */,
                                    win32.DUPLICATE_SAME_ACCESS);

      their_pipes[2] = ok && win32.Handle(handle);
    }

    if (!their_pipes.every(handle => handle)) {
      throw new Error("Failed to create pipe");
    }

    this.pipes = our_pipes;

    return their_pipes;
  }

  /**
   * Creates a null-separated, null-terminated string list.
   *
   * @param {Array<string>} strings
   * @returns {win32.WCHAR.array}
   */
  stringList(strings) {
    // Remove empty strings, which would terminate the list early.
    strings = strings.filter(string => string);

    let string = strings.join("\0") + "\0\0";

    return win32.WCHAR.array()(string);
  }

  /**
   * Quotes a string for use as a single command argument, using Windows quoting
   * conventions.
   *
   * @see https://msdn.microsoft.com/en-us/library/17w5ykft(v=vs.85).aspx
   *
   * @param {string} str
   *        The argument string to quote.
   * @returns {string}
   */
  quoteString(str) {
    if (!/[\s"]/.test(str)) {
      return str;
    }

    let escaped = str.replace(/(\\*)("|$)/g, (m0, m1, m2) => {
      if (m2) {
        m2 = `\\${m2}`;
      }
      return `${m1}${m1}${m2}`;
    });

    return `"${escaped}"`;
  }

  spawn(options) {
    let {command, arguments: args} = options;

    args = args.map(arg => this.quoteString(arg));

    let envp = this.stringList(options.environment);

    let handles = this.initPipes(options);

    let processFlags = win32.CREATE_NO_WINDOW
                     | win32.CREATE_UNICODE_ENVIRONMENT;

    let startupInfo = new win32.STARTUPINFOW();
    startupInfo.cb = win32.STARTUPINFOW.size;
    startupInfo.dwFlags = win32.STARTF_USESTDHANDLES;

    startupInfo.hStdInput = handles[0];
    startupInfo.hStdOutput = handles[1];
    startupInfo.hStdError = handles[2];

    let procInfo = new win32.PROCESS_INFORMATION();

    let ok = libc.CreateProcessW(
      command, args.join(" "),
      null, /* Security attributes */
      null, /* Thread security attributes */
      true, /* Inherits handles */
      processFlags, envp, options.workdir,
      startupInfo.address(),
      procInfo.address());

    for (let handle of new Set(handles)) {
      handle.dispose();
    }

    if (!ok) {
      for (let pipe of this.pipes) {
        pipe.close();
      }
      throw new Error("Failed to create process");
    }

    libc.CloseHandle(procInfo.hThread);

    this.handle = win32.Handle(procInfo.hProcess);
    this.pid = procInfo.dwProcessId;
  }

  /**
   * Called when our process handle is signaled as active, meaning the process
   * has exited.
   */
  onReady() {
    this.wait();
  }

  /**
   * Attempts to wait for the process's exit status, without blocking. If
   * successful, resolves the `exitPromise` to the process's exit value.
   *
   * @returns {integer|null}
   *          The process's exit status, if it has already exited.
   */
  wait() {
    if (this.exitCode !== null) {
      return this.exitCode;
    }

    let status = win32.DWORD();

    let ok = libc.GetExitCodeProcess(this.handle, status.address());
    if (ok && status.value != win32.STILL_ACTIVE) {
      let exitCode = status.value;
      if (this.killed && exitCode == TERMINATE_EXIT_CODE) {
        // If we forcibly terminated the process, return the force kill exit
        // code that we return on other platforms.
        exitCode = -9;
      }

      this.resolveExit(exitCode);
      this.exitCode = exitCode;

      this.handle.dispose();
      this.handle = null;

      for (let pipe of this.pipes) {
        pipe.maybeClose();
      }

      io.updatePollEvents();

      return exitCode;
    }
  }
}

io = {
  events: null,
  eventHandlers: null,

  pipes: new Map(),

  processes: new Map(),

  interval: null,

  getPipe(pipeId) {
    let pipe = this.pipes.get(pipeId);

    if (!pipe) {
      let error = new Error("File closed");
      error.errorCode = SubprocessConstants.ERROR_END_OF_FILE;
      throw error;
    }
    return pipe;
  },

  getProcess(processId) {
    let process = this.processes.get(processId);

    if (!process) {
      throw new Error(`Invalid process ID: ${processId}`);
    }
    return process;
  },

  updatePollEvents() {
    let handlers = [...this.pipes.values(),
                    ...this.processes.values()];

    handlers = handlers.filter(handler => handler.event);

    this.eventHandlers = handlers;

    let handles = handlers.map(handler => handler.event);
    this.events = win32.HANDLE.array()(handles);

    if (handles.length && !this.interval) {
      this.interval = setInterval(this.poll.bind(this), POLL_INTERVAL);
    } else if (!handlers.length && this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  },

  poll() {
    for (;;) {
      let events = this.events;
      let handlers = this.eventHandlers;

      let result = libc.WaitForMultipleObjects(events.length, events,
                                               false, POLL_TIMEOUT);

      if (result < handlers.length) {
        try {
          handlers[result].onReady();
        } catch (e) {
          console.error(e);
          debug(`Worker error: ${e} :: ${e.stack}`);
          handlers[result].onError();
        }
      } else {
        break;
      }
    }
  },

  addProcess(process) {
    this.processes.set(process.id, process);

    for (let pipe of process.pipes) {
      this.pipes.set(pipe.id, pipe);
    }
  },

  cleanupProcess(process) {
    this.processes.delete(process.id);
  },
};
