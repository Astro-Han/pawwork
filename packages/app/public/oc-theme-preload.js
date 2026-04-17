;(function () {
  var key = "opencode-theme-id"
  var schemeKey = "opencode-color-scheme"
  var cssLightKey = "opencode-theme-css-light"
  var cssDarkKey = "opencode-theme-css-dark"
  var storedTheme = localStorage.getItem(key)

  if (storedTheme !== "pawwork") {
    localStorage.setItem(key, "pawwork")
    localStorage.removeItem(cssLightKey)
    localStorage.removeItem(cssDarkKey)
  }
  localStorage.setItem(schemeKey, "light")

  document.documentElement.dataset.theme = "pawwork"
  document.documentElement.dataset.colorScheme = "light"
})()
