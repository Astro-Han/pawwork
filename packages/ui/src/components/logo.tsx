import { ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 100 90"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <ellipse cx="24" cy="22" rx="11" ry="14" fill="var(--icon-strong-base)" />
      <ellipse cx="50" cy="10" rx="10" ry="13" fill="var(--icon-strong-base)" />
      <ellipse cx="76" cy="22" rx="11" ry="14" fill="var(--icon-strong-base)" />
      <path
        d="M22 50C22 38 34 33 44 39C47 41 50 41 50 41C50 41 53 41 56 39C66 33 78 38 78 50C78 67 64 80 50 80C36 80 22 67 22 50Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 100 90"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <ellipse cx="24" cy="22" rx="11" ry="14" fill="var(--icon-base)" />
      <ellipse cx="50" cy="10" rx="10" ry="13" fill="var(--icon-base)" />
      <ellipse cx="76" cy="22" rx="11" ry="14" fill="var(--icon-base)" />
      <path
        d="M22 50C22 38 34 33 44 39C47 41 50 41 50 41C50 41 53 41 56 39C66 33 78 38 78 50C78 67 64 80 50 80C36 80 22 67 22 50Z"
        fill="var(--icon-base)"
      />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 90"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <ellipse cx="24" cy="22" rx="11" ry="14" fill="var(--icon-strong-base)" />
      <ellipse cx="50" cy="10" rx="10" ry="13" fill="var(--icon-strong-base)" />
      <ellipse cx="76" cy="22" rx="11" ry="14" fill="var(--icon-strong-base)" />
      <path
        d="M22 50C22 38 34 33 44 39C47 41 50 41 50 41C50 41 53 41 56 39C66 33 78 38 78 50C78 67 64 80 50 80C36 80 22 67 22 50Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}
