// Ensure that we can overwrite methods when more tha one is present.

var test = `
var result = 0;
// Regardless of order, the constructor is overridden by any CPN, because it's
// processed seperately.
class a { [\"constructor\"]() { result += 1; }; constructor() { result += 2; } }
var aInst = new a();
assertEq(result, 2);
aInst.constructor();
assertEq(result, 3);

class b { constructor() { result += 2; } [\"constructor\"]() { result += 1; }; }
var bInst = new b();
assertEq(result, 5);
bInst.constructor();
assertEq(result, 6);

class c { constructor() { } method() { result += 1 } get method() { result += 2 } }
new c().method;
assertEq(result, 8);

class d { constructor() { } get method() { result += 1 } method() { result += 2 } }
new d().method();
assertEq(result, 10);

// getters and setter should not overwrite each other, but merge cleanly.
class e { constructor() { } get method() { result += 1 } set method(x) { } }
new e().method;
assertEq(result, 11);

class f { constructor() { }
          set method(x) { throw "NO"; }
          method() { throw "NO" }
          get method() { return new Function("result += 1"); }
        }
new f().method();
assertEq(result, 12);
`;

if (classesEnabled())
    eval(test);

if (typeof reportCompare === "function")
    reportCompare(0, 0, "OK");