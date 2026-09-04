export interface Review { readonly sourceId: string; readonly text: string; readonly author?: string; readonly rating?: number; readonly provider?: "GOOGLE_MAPS"; }
export interface Location { readonly address: string; readonly sourceId: string; readonly embedUrl: string; }
export interface CopyContent { readonly role: string; readonly text: string; readonly sourceId: string; }
export interface MediaContent { readonly assetId: string; readonly role: string; readonly publicPath: string; readonly sourceDigest: `sha256:${string}`; readonly alt: string; }
export interface ActionContent { readonly capabilityId: string; readonly label: string; readonly href: string; readonly sourceId: string; readonly emphasis?: "primary" | "secondary"; }
export interface RouteContent { readonly path: string; readonly navLabel: string; readonly purpose: string; readonly capabilityIds: readonly string[]; readonly copyRoles: readonly string[]; readonly mediaRoles: readonly string[]; readonly copy: readonly CopyContent[]; readonly media: readonly MediaContent[]; readonly actions: readonly ActionContent[]; }
export interface SiteData { readonly projectId: string; readonly brand: string; readonly routes: readonly { readonly path: string; readonly navLabel: string }[]; readonly routeContent: readonly RouteContent[]; readonly copy: readonly CopyContent[]; readonly media: readonly MediaContent[]; readonly dnaSubject: string; readonly recipeId: string; }
export interface Features { readonly location: Location | null; readonly reviews: readonly Review[]; readonly greenCapabilities: readonly string[]; }
