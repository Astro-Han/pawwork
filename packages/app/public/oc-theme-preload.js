// Phase 1 ships only the `pawwork` theme, which is locked to light mode.
// When a dark-capable theme is bundled, this file must gain a theme-aware
// guard so `pawwork-color-scheme` is forced to "light" ONLY for light-only
// themes; tracked in issue #23.
;(function () {
  var key = "pawwork-theme-id"
  var schemeKey = "pawwork-color-scheme"
  var cssLightKey = "pawwork-theme-css-light"
  var cssDarkKey = "pawwork-theme-css-dark"

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
