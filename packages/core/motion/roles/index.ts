export const motionRoles = {
  feedback: "feedback",
  transition: "transition",
  enter: "enter",
  exit: "exit",
  hover: "hover",
  focus: "focus",
  loading: "loading",
  navigation: "navigation",
  scroll: "scroll",
  emphasis: "emphasis"
} as const;

export type MotionRole = (typeof motionRoles)[keyof typeof motionRoles];
