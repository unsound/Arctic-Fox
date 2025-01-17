/* -*- indent-tabs-mode: nil; js-indent-level: 4 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

var gPrivacyPane = {

  /**
   * Whether the use has selected the auto-start private browsing mode in the UI.
   */
  _autoStartPrivateBrowsing: false,

  /**
   * Whether the prompt to restart Firefox should appear when changing the autostart pref.
   */
  _shouldPromptForRestart: true,

  /**
   * Sets up the UI for the number of days of history to keep, and updates the
   * label of the "Clear Now..." button.
   * Also restores the previously selected tab or tab index passed as argument.
   */
  init: function ()
  {
    this._inited = true;
    var privacyPrefs = document.getElementById("privacyPrefs");

    var extraArgs = window.arguments[1];
    if (extraArgs && extraArgs["privacyTab"]){
      privacyPrefs.selectedTab = document.getElementById(extraArgs["privacyTab"]);
    } else {
      var preference = document.getElementById("browser.preferences.privacy.selectedTabIndex");
      if (preference.value !== null)
        privacyPrefs.selectedIndex = preference.value;
    }
  
    this._updateSanitizeSettingsButton();
    this.initializeHistoryMode();
    this.updateHistoryModePane();
    this.updatePrivacyMicroControls();
    this.initAutoStartPrivateBrowsingReverter();
  },

  /**
   * Stores the identity of the current tab in preferences so that the selected
   * tab can be persisted between openings of the preferences window.
   */
  tabSelectionChanged: function ()
  {
    if (!this._inited)
      return;
    var privacyPrefs = document.getElementById("privacyPrefs");
    var preference = document.getElementById("browser.preferences.privacy.selectedTabIndex");
    preference.valueFromPreferences = privacyPrefs.selectedIndex;
  },
  
  // HISTORY MODE

  /**
   * The list of preferences which affect the initial history mode settings.
   * If the auto start private browsing mode pref is active, the initial
   * history mode would be set to "Don't remember anything".
   * If all of these preferences have their default values, and the auto-start
   * private browsing mode is not active, the initial history mode would be
   * set to "Remember everything".
   * Otherwise, the initial history mode would be set to "Custom".
   *
   * Extensions adding their own preferences can append their IDs to this array if needed.
   */
  prefsForDefault: [
    "places.history.enabled",
    "browser.formfill.enable",
    "network.cookie.cookieBehavior",
    "network.cookie.lifetimePolicy",
    "privacy.sanitize.sanitizeOnShutdown"
  ],

  /**
   * The list of control IDs which are dependent on the auto-start private
   * browsing setting, such that in "Custom" mode they would be disabled if
   * the auto-start private browsing checkbox is checked, and enabled otherwise.
   *
   * Extensions adding their own controls can append their IDs to this array if needed.
   */
  dependentControls: [
    "rememberHistory",
    "rememberForms",
    "keepUntil",
    "keepCookiesUntil",
    "alwaysClear",
    "clearDataSettings"
  ],

  /**
   * Check whether all the preferences values are set to their default values
   *
   * @param aPrefs an array of pref names to check for
   * @returns boolean true if all of the prefs are set to their default values,
   *                  false otherwise
   */
  _checkDefaultValues: function(aPrefs) {
    for (let i = 0; i < aPrefs.length; ++i) {
      let pref = document.getElementById(aPrefs[i]);
      if (pref.value != pref.defaultValue)
        return false;
    }
    return true;
  },

  /**
   * Initialize the history mode menulist based on the privacy preferences
   */
  initializeHistoryMode: function PPP_initializeHistoryMode()
  {
    let mode;
    let getVal = function (aPref)
      document.getElementById(aPref).value;

    if (this._checkDefaultValues(this.prefsForDefault)) {
      if (getVal("browser.privatebrowsing.autostart"))
        mode = "dontremember";
      else 
        mode = "remember";
    }
    else
      mode = "custom";

    document.getElementById("historyMode").value = mode;
  },

  /**
   * Update the selected pane based on the history mode menulist
   */
  updateHistoryModePane: function PPP_updateHistoryModePane()
  {
    let selectedIndex = -1;
    switch (document.getElementById("historyMode").value) {
    case "remember":
      selectedIndex = 0;
      break;
    case "dontremember":
      selectedIndex = 1;
      break;
    case "custom":
      selectedIndex = 2;
      break;
    }
    document.getElementById("historyPane").selectedIndex = selectedIndex;
  },

  /**
   * Update the Tracking preferences based on controls.
   */
  setTrackingPrefs: function PPP_setTrackingPrefs()
  {
    let dntRadioGroup = document.getElementById("doNotTrackSelection"),
        dntValuePref = document.getElementById("privacy.donottrackheader.value"),
        dntEnabledPref = document.getElementById("privacy.donottrackheader.enabled");

    // if the selected radio button says "no preference", set on/off pref to
    // false and don't change the value pref.
    if (dntRadioGroup.selectedItem.value == -1) {
      dntEnabledPref.value = false;
      return dntValuePref.value;
    }

    dntEnabledPref.value = true;
    return dntRadioGroup.selectedItem.value;
  },

  /**
   * Obtain the tracking preference value and reflect it in the UI.
   */
  getTrackingPrefs: function PPP_getTrackingPrefs()
  {
    let dntValuePref = document.getElementById("privacy.donottrackheader.value"),
        dntEnabledPref = document.getElementById("privacy.donottrackheader.enabled");

    // if DNT is enbaled, select the value from the selected radio
    // button, otherwise choose the "no preference" radio button
    if (dntEnabledPref.value)
      return dntValuePref.value;

    return document.getElementById("dntnopref").value;
  },

  /**
   * Update the private browsing auto-start pref and the history mode
   * micro-management prefs based on the history mode menulist
   */
  updateHistoryModePrefs: function PPP_updateHistoryModePrefs()
  {
    let pref = document.getElementById("browser.privatebrowsing.autostart");
    switch (document.getElementById("historyMode").value) {
    case "remember":
      if (pref.value)
        pref.value = false;

      // select the remember history option
      document.getElementById("places.history.enabled").value = true;

      // select the remember forms history option
      document.getElementById("browser.formfill.enable").value = true;

      // select the accept cookies option
      document.getElementById("network.cookie.cookieBehavior").value = 0;
      // select the cookie lifetime policy option
      document.getElementById("network.cookie.lifetimePolicy").value = 0;

      // select the clear on close option
      document.getElementById("privacy.sanitize.sanitizeOnShutdown").value = false;
      break;
    case "dontremember":
      if (!pref.value)
        pref.value = true;
      break;
    }
  },

  /**
   * Update the privacy micro-management controls based on the
   * value of the private browsing auto-start checkbox.
   */
  updatePrivacyMicroControls: function PPP_updatePrivacyMicroControls()
  {
    if (document.getElementById("historyMode").value == "custom") {
      let disabled = this._autoStartPrivateBrowsing =
        document.getElementById("privateBrowsingAutoStart").checked;
      this.dependentControls
          .forEach(function (aElement)
                   document.getElementById(aElement).disabled = disabled);

      const Ci = Components.interfaces;
      // adjust the cookie controls status
      this.readAcceptCookies();
      let lifetimePolicy = document.getElementById("network.cookie.lifetimePolicy").value;
      if (lifetimePolicy != Ci.nsICookieService.ACCEPT_NORMALLY &&
          lifetimePolicy != Ci.nsICookieService.ACCEPT_SESSION &&
          lifetimePolicy != Ci.nsICookieService.ACCEPT_FOR_N_DAYS) {
        lifetimePolicy = Ci.nsICookieService.ACCEPT_NORMALLY;
      }
      document.getElementById("keepCookiesUntil").value = disabled ? 2 : lifetimePolicy;

      // adjust the checked state of the sanitizeOnShutdown checkbox
      document.getElementById("alwaysClear").checked = disabled ? false :
        document.getElementById("privacy.sanitize.sanitizeOnShutdown").value;

      // adjust the checked state of the remember history checkboxes
      document.getElementById("rememberHistory").checked = disabled ? false :
        document.getElementById("places.history.enabled").value;
      document.getElementById("rememberForms").checked = disabled ? false :
        document.getElementById("browser.formfill.enable").value;

      if (!disabled) {
        // adjust the Settings button for sanitizeOnShutdown
        this._updateSanitizeSettingsButton();
      }
    }
  },

  // PRIVATE BROWSING

  /**
   * Initialize the starting state for the auto-start private browsing mode pref reverter.
   */
  initAutoStartPrivateBrowsingReverter: function PPP_initAutoStartPrivateBrowsingReverter()
  {
    let mode = document.getElementById("historyMode");
    let autoStart = document.getElementById("privateBrowsingAutoStart");
    this._lastMode = mode.selectedIndex;
    this._lastCheckState = autoStart.hasAttribute('checked');
  },

  _lastMode: null,
  _lasCheckState: null,
  updateAutostart: function PPP_updateAutostart() {
      let mode = document.getElementById("historyMode");
      let autoStart = document.getElementById("privateBrowsingAutoStart");
      let pref = document.getElementById("browser.privatebrowsing.autostart");
      if ((mode.value == "custom" && this._lastCheckState == autoStart.checked) ||
          (mode.value == "remember" && !this._lastCheckState) ||
          (mode.value == "dontremember" && this._lastCheckState)) {
          // These are all no-op changes, so we don't need to prompt.
          this._lastMode = mode.selectedIndex;
          this._lastCheckState = autoStart.hasAttribute('checked');
          return;
      }

      if (!this._shouldPromptForRestart) {
        // We're performing a revert. Just let it happen.
        return;
      }

      const Cc = Components.classes, Ci = Components.interfaces;
      let brandName = document.getElementById("bundleBrand").getString("brandShortName");
      let bundle = document.getElementById("bundlePreferences");
      let msg = bundle.getFormattedString(autoStart.checked ?
                                          "featureEnableRequiresRestart" : "featureDisableRequiresRestart",
                                          [brandName]);
      let title = bundle.getFormattedString("shouldRestartTitle", [brandName]);
      let prompts = Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(Ci.nsIPromptService);
      let shouldProceed = prompts.confirm(window, title, msg)
      if (shouldProceed) {
        let cancelQuit = Cc["@mozilla.org/supports-PRBool;1"]
                           .createInstance(Ci.nsISupportsPRBool);
        Services.obs.notifyObservers(cancelQuit, "quit-application-requested",
                                     "restart");
        shouldProceed = !cancelQuit.data;

        if (shouldProceed) {
          pref.value = autoStart.hasAttribute('checked');
          document.documentElement.acceptDialog();
          let appStartup = Cc["@mozilla.org/toolkit/app-startup;1"]
                             .getService(Ci.nsIAppStartup);
          appStartup.quit(Ci.nsIAppStartup.eAttemptQuit |  Ci.nsIAppStartup.eRestart);
          return;
        }
      }

      this._shouldPromptForRestart = false;

      if (this._lastCheckState) {
        autoStart.checked = "checked";
      } else {
        autoStart.removeAttribute('checked');
      }
      mode.selectedIndex = this._lastMode;
      mode.doCommand();

      this._shouldPromptForRestart = true;
  },

  // HISTORY

  /**
   * Read the location bar enabled and suggestion prefs
   * @return Int value for suggestion menulist
   */
  readSuggestionPref: function PPP_readSuggestionPref()
  {
    let getVal = function(aPref)
      document.getElementById("browser.urlbar." + aPref).value;

    // Suggest nothing if autocomplete is not enabled
    if (!getVal("autocomplete.enabled"))
      return -1;

    // Bottom 2 bits of default.behavior specify history/bookmark
    return getVal("default.behavior") & 3;
  },

  /*
   * Preferences:
   *
   * places.history.enabled
   * - whether history is enabled or not
   * browser.formfill.enable
   * - true if entries in forms and the search bar should be saved, false
   *   otherwise
   */

  // COOKIES

  /*
   * Preferences:
   *
   * network.cookie.cookieBehavior
   * - determines how the browser should handle cookies:
   *     0   means enable all cookies
   *     1   means reject all third party cookies
   *     2   means disable all cookies
   *     3   means reject third party cookies unless at least one is already set for the eTLD
   *         see netwerk/cookie/src/nsCookieService.cpp for details
   * network.cookie.lifetimePolicy
   * - determines how long cookies are stored:
   *     0   means keep cookies until they expire
   *     2   means keep cookies until the browser is closed
   */

  /**
   * Reads the network.cookie.cookieBehavior preference value and
   * enables/disables the rest of the cookie UI accordingly, returning true
   * if cookies are enabled.
   */
  readAcceptCookies: function ()
  {
    var pref = document.getElementById("network.cookie.cookieBehavior");
    var acceptThirdPartyLabel = document.getElementById("acceptThirdPartyLabel");
    var acceptThirdPartyMenu = document.getElementById("acceptThirdPartyMenu");
    var keepUntil = document.getElementById("keepUntil");
    var menu = document.getElementById("keepCookiesUntil");

    // enable the rest of the UI for anything other than "disable all cookies"
    var acceptCookies = (pref.value != 2);

    acceptThirdPartyLabel.disabled = acceptThirdPartyMenu.disabled = !acceptCookies;
    keepUntil.disabled = menu.disabled = this._autoStartPrivateBrowsing || !acceptCookies;
    
    return acceptCookies;
  },

  /**
   * Enables/disables the "keep until" label and menulist in response to the
   * "accept cookies" checkbox being checked or unchecked.
   */
  writeAcceptCookies: function ()
  {
    var accept = document.getElementById("acceptCookies");
    var acceptThirdPartyMenu = document.getElementById("acceptThirdPartyMenu");

    // if we're enabling cookies, automatically select 'accept third party always'
    if (accept.checked)
      acceptThirdPartyMenu.selectedIndex = 0;

    return accept.checked ? 0 : 2;
  },
  
  /**
   * Converts between network.cookie.cookieBehavior and the third-party cookie UI
   */
  readAcceptThirdPartyCookies: function ()
  {
    var pref = document.getElementById("network.cookie.cookieBehavior");
    switch (pref.value)
    {
      case 0:
        return "always";
      case 1:
        return "never";
      case 2:
        return "never";
      case 3:
        return "visited";
      default:
        return undefined;
    }
  },
  
  writeAcceptThirdPartyCookies: function ()
  {
    var accept = document.getElementById("acceptThirdPartyMenu").selectedItem;
    switch (accept.value)
    {
      case "always":
        return 0;
      case "visited":
        return 3;
      case "never":
        return 1;
      default:
        return undefined;
    }
  },

  /**
   * Displays fine-grained, per-site preferences for cookies.
   */
  showCookieExceptions: function ()
  {
    var bundlePreferences = document.getElementById("bundlePreferences");
    var params = { blockVisible   : true, 
                   sessionVisible : true, 
                   allowVisible   : true, 
                   prefilledHost  : "", 
                   permissionType : "cookie",
                   windowTitle    : bundlePreferences.getString("cookiepermissionstitle"),
                   introText      : bundlePreferences.getString("cookiepermissionstext") };
    document.documentElement.openWindow("Browser:Permissions",
                                        "chrome://browser/content/preferences/permissions.xul",
                                        "", params);
  },

  /**
   * Displays all the user's cookies in a dialog.
   */  
  showCookies: function (aCategory)
  {
    document.documentElement.openWindow("Browser:Cookies",
                                        "chrome://browser/content/preferences/cookies.xul",
                                        "", null);
  },

  // CLEAR PRIVATE DATA

  /*
   * Preferences:
   *
   * privacy.sanitize.sanitizeOnShutdown
   * - true if the user's private data is cleared on startup according to the
   *   Clear Private Data settings, false otherwise
   */

  /**
   * Displays the Clear Private Data settings dialog.
   */
  showClearPrivateDataSettings: function ()
  {
    document.documentElement.openSubDialog("chrome://browser/content/preferences/sanitize.xul",
                                           "", null);
  },


  /**
   * Displays a dialog from which individual parts of private data may be
   * cleared.
   */
  clearPrivateDataNow: function (aClearEverything)
  {
    var ts = document.getElementById("privacy.sanitize.timeSpan");
    var timeSpanOrig = ts.value;
    if (aClearEverything)
      ts.value = 0;

    const Cc = Components.classes, Ci = Components.interfaces;
    var glue = Cc["@mozilla.org/browser/browserglue;1"]
                 .getService(Ci.nsIBrowserGlue);
    glue.sanitize(window);

    // reset the timeSpan pref
    if (aClearEverything)
      ts.value = timeSpanOrig;
    Services.obs.notifyObservers(null, "clear-private-data", null);
  },

  /**
   * Enables or disables the "Settings..." button depending
   * on the privacy.sanitize.sanitizeOnShutdown preference value
   */
  _updateSanitizeSettingsButton: function () {
    var settingsButton = document.getElementById("clearDataSettings");
    var sanitizeOnShutdownPref = document.getElementById("privacy.sanitize.sanitizeOnShutdown");
    
    settingsButton.disabled = !sanitizeOnShutdownPref.value;
   }

};
