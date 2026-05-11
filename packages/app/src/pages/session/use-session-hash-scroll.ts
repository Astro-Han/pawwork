import { useLocation, useNavigate } from "@solidjs/router"
import { createSessionHashScroll, type SessionHashScrollInput } from "./use-session-hash-scroll-core"

export const useSessionHashScroll = (input: SessionHashScrollInput) => {
  const location = useLocation()
  const navigate = useNavigate()

  return createSessionHashScroll(input, location, navigate)
}
