import { initI18n, t } from "./i18n"
import { getStartupState } from "./startup-state"

export const UPDATER_ENABLED = () => getStartupState().updaterEnabled()

export async function runUpdater({ alertOnFail }: { alertOnFail: boolean }) {
  await initI18n()
  try {
    await window.api.runUpdater(alertOnFail)
  } catch {
    if (alertOnFail) {
      window.alert(t("desktop.updater.checkFailed.message"))
    }
  }
}
