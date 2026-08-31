declare module "apca-w3" {
  export function APCAcontrast(textY: number, backgroundY: number, places?: number): number | string;
  export function sRGBtoY(color: readonly number[]): number;
  export function fontLookupAPCA(contrast: number, places?: number): readonly (number | string)[];
}
