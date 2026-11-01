export type ScrollDetail = {
  schemaVersion: 1;
  kind: "scroll-svg";
  variants: {
    name: string;
    minWidth: number;
    viewBox: [number, number, number, number];
    path: string;
    transform: [number, number, number, number, number, number];
    stroke: string;
    strokeWidth: number;
    linecap: "butt" | "round" | "square";
    linejoin: "miter" | "round" | "bevel";
  }[];
};

export type ScrollOptions = {
  /** The top of the host reaches this fraction of viewport height to start drawing. */
  start?: number;
  /** The bottom of the host reaches this fraction to finish drawing. */
  end?: number;
  smoothingMs?: number;
  headRadius?: number;
  endRingRadius?: number;
};

export type DetailConfig = {
  schemaVersion: 1;
  kind: "scroll-svg";
  route: string;
  selector: string;
  readySelector: string;
  viewports: {
    name: string;
    width: number;
    height: number;
    minWidth: number;
    touch?: boolean;
  }[];
  padding?: number;
  timeoutMs?: number;
};
