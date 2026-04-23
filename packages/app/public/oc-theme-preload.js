;(function () {
  var themeKey = "pawwork-theme-id"
  var schemeKey = "pawwork-color-scheme"
  var cssLightKey = "pawwork-theme-css-light"
  var cssDarkKey = "pawwork-theme-css-dark"
  var scheme = "light"

  try {
    var storedTheme = localStorage.getItem(themeKey)
    if (storedTheme !== "pawwork") {
      localStorage.setItem(themeKey, "pawwork")
      localStorage.removeItem(cssLightKey)
      localStorage.removeItem(cssDarkKey)
    }

    var storedScheme = localStorage.getItem(schemeKey)
    if (storedScheme === "light" || storedScheme === "dark") {
      scheme = storedScheme
    } else if (storedScheme === "system") {
      scheme =
        window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    } else {
      localStorage.setItem(schemeKey, "light")
    }
  } catch (_err) {
    // Private mode / blocked storage / non-browser environment: the app still
    // needs the dataset attributes below so the first paint is not unstyled.
  }

  document.documentElement.dataset.theme = "pawwork"
  document.documentElement.dataset.colorScheme = scheme
})()
