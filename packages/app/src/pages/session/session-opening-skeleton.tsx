export function SessionOpeningSkeleton(props: {
  visible: boolean
  transitioning: boolean
  openingLabel: string
  overlay?: boolean
}) {
  return (
    <div
      class="size-full bg-bg-base px-4 transition-opacity duration-[var(--duration-base)] ease-out motion-reduce:transition-none md:px-5"
      classList={{
        "absolute inset-0 z-10 pointer-events-none": props.overlay,
        "opacity-100": props.visible,
        "opacity-0": !props.visible,
      }}
      role="status"
      data-component="session-opening-state"
      data-state="skeleton"
      data-transitioning={props.transitioning ? "true" : "false"}
    >
      <span class="sr-only">{props.openingLabel}</span>
      <div
        class="mx-auto flex h-full w-full flex-col gap-6 pt-4 md:max-w-[800px] 2xl:max-w-[1000px]"
        aria-hidden="true"
      >
        <SessionOpeningSkeletonTurn side="user" lines={[72, 46]} />
        <SessionOpeningSkeletonTurn side="assistant" lines={[92, 78, 54]} />
        <SessionOpeningSkeletonTurn side="user" lines={[64]} />
        <SessionOpeningSkeletonTurn side="assistant" lines={[86, 70, 42]} />
      </div>
    </div>
  )
}

function SessionOpeningSkeletonTurn(props: { side: "user" | "assistant"; lines: number[] }) {
  const isUser = props.side === "user"
  return (
    <div
      class="flex w-full"
      classList={{
        "justify-end": isUser,
        "justify-start": !isUser,
      }}
      data-component="session-opening-skeleton-turn"
      data-side={props.side}
    >
      <div
        class="min-w-0 rounded-[var(--radius-md)]"
        classList={{
          "w-[62%] max-w-[34rem] bg-surface-raised px-4 py-3": isUser,
          "w-[76%] max-w-[42rem] py-1": !isUser,
        }}
      >
        <div class="flex flex-col gap-2">
          {props.lines.map((width) => (
            <div
              class="h-3 rounded-full bg-border-weaker opacity-80 motion-safe:animate-pulse"
              data-component="session-opening-skeleton-line"
              style={{ width: `${width}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
