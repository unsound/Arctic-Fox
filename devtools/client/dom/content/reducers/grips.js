/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const constants = require("../constants");

/**
 * Initial state definition
 */
function getInitialState() {
  return new Map();
}

/**
 * Maintain a cache of received grip responses from the backend.
 */
function grips(state = getInitialState(), action) {
  // This reducer supports only one action, fetching actor properties
  // from the backend so, bail out if we are dealing with any other
  // action.
  if (action.type != constants.FETCH_PROPERTIES) {
    return state;
  }

  switch (action.status) {
    case "start":
      return onRequestProperties(state, action);
    case "end":
      return onReceiveProperties(state, action);
  }

  return state;
}

/**
 * Handle requestProperties action
 */
function onRequestProperties(state, action) {
  return state;
}

/**
 * Handle receiveProperties action
 */
function onReceiveProperties(cache, action) {
  let response = action.response;
  let from = response.from;

  // Properly deal with getters.
  mergeProperties(response);

  // Compute list of requested children.
  let ownProps = response.ownProperties || response.preview.ownProperties || [];
  let props = Object.keys(ownProps).map(key => {
    return new Property(key, ownProps[key], key);
  });

  props.sort(sortName);

  // Return new state/map.
  let newCache = new Map(cache);
  newCache.set(from, props);

  return newCache;
}

// Helpers

function mergeProperties(response) {
  let { ownProperties } = response;

  // 'safeGetterValues' is new and isn't necessary defined on old grips.
  let safeGetterValues = response.safeGetterValues || {};

  // Merge the safe getter values into one object such that we can use it
  // in variablesView.
  for (let name of Object.keys(safeGetterValues)) {
    if (name in ownProperties) {
      let { getterValue, getterPrototypeLevel } = safeGetterValues[name];
      ownProperties[name].getterValue = getterValue;
      ownProperties[name].getterPrototypeLevel = getterPrototypeLevel;
    } else {
      ownProperties[name] = safeGetterValues[name];
    }
  }
}

function sortName(a, b) {
  // Display non-enumerable properties at the end.
  if (!a.value.enumerable && b.value.enumerable) {
    return 1;
  }
  if (a.value.enumerable && !b.value.enumerable) {
    return -1;
  }
  return a.name > b.name ? 1 : -1;
}

function Property(name, value, key) {
  this.name = name;
  this.value = value;
  this.key = key;
}

// Exports from this module
exports.grips = grips;
exports.Property = Property;
