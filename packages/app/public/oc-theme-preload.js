;(function () {
  var key = "opencode-theme-id"
  var schemeKey = "opencode-color-scheme"
  var storedTheme = localStorage.getItem(key)
  var storedScheme = localStorage.getItem(schemeKey)
  var firstInstall = !storedTheme && !storedScheme
  var themeId = storedTheme || "pawwork"

  if (themeId === "oc-1") {
    themeId = "oc-2"
    localStorage.setItem(key, themeId)
    localStorage.removeItem("opencode-theme-css-light")
    localStorage.removeItem("opencode-theme-css-dark")
  }

  var scheme = themeId === "pawwork" ? "light" : storedScheme || (firstInstall ? "light" : "system")
  if (themeId === "pawwork") localStorage.setItem(schemeKey, "light")
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  if (themeId === "pawwork" || themeId === "oc-2") return

  var css = localStorage.getItem("opencode-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
