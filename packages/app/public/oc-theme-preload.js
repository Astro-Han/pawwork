// Phase 1 ships only the `pawwork` theme, which is locked to light mode.
// When a dark-capable theme is bundled, this file must gain a theme-aware
// guard so `opencode-color-scheme` is forced to "light" ONLY for light-only
// themes; tracked in issue #23.
;(function () {
  var key = "opencode-theme-id"
  var schemeKey = "opencode-color-scheme"
  var cssLightKey = "opencode-theme-css-light"
  var cssDarkKey = "opencode-theme-css-dark"

  try {
    var storedTheme = localStorage.getItem(key)

    if (storedTheme !== "pawwork") {
      localStorage.setItem(key, "pawwork")
      localStorage.removeItem(cssLightKey)
      localStorage.removeItem(cssDarkKey)
    }
    localStorage.setItem(schemeKey, "light")
  } catch (_err) {
    // Private mode / blocked storage / non-browser environment: the app still
    // needs the dataset attributes below so the first paint is not unstyled.
  }

  document.documentElement.dataset.theme = "pawwork"
  document.documentElement.dataset.colorScheme = "light"
})()
