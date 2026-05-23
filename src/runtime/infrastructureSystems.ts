/**
 * Infrastructure systems + buffers shared by all runtime configurations.
 *
 * The Running graph references `bindingSwapSystem` + `overlayVisibilitySystem`,
 * and the LibraryViewer mode references all three. They must be registered
 * before `buildAndRegisterCoreGraphs` validates. Tests + bootstrap both
 * funnel through this helper.
 *
 * Safe defaults (null target, empty catalog) make these systems inert so
 * tests don't need DOM or character bindings just to validate graphs.
 * Bootstrap passes the real target + catalog.
 *
 * Tech-debt payoff 2026-05-23: previously inlined in bootstrap; tests
 * had to duplicate the registration calls. Centralised here.
 */

import type { Registry } from "./registry";
import type { ControllerBinding } from "./moduleSlots";
import {
  createLibraryViewerBuffer,
  createLibraryViewerSystem,
  createLibraryViewerRenderSystem,
  LIBRARY_VIEWER_MODE_ID,
  type LibraryViewerRenderTarget,
} from "./libraryViewer";
import { createBindingSwapSystem } from "./bindingSwapSystem";
import { createOverlayVisibilitySystem } from "./overlayVisibility";

export interface InfrastructureOptions {
  /** DOM panel for the Library Viewer renderer + overlay visibility
   *  toggle. Null = both systems become no-ops. */
  libraryViewerTarget?: LibraryViewerRenderTarget | null;
  /** Catalog of character bindings the BindingSwapSystem looks up by id
   *  on BindingRequested events. Defaults to empty (= no-op on every
   *  request; tests that don't exercise bindings can omit). */
  bindingCatalog?: ControllerBinding[];
}

/**
 * Register the buffers + systems that the Running graph and the
 * LibraryViewer mode reference. Idempotent within a single registry:
 * caller must not have already registered any of these.
 */
export function registerInfrastructureSystems(
  reg: Registry,
  opts: InfrastructureOptions = {},
): void {
  // ControllerParamsBuffer is now a core buffer (registered by
  // registerCoreBuffers) since core character systems read from it.
  reg.registerBuffer(createLibraryViewerBuffer());
  reg.registerSystem(createLibraryViewerSystem(reg));
  reg.registerSystem(createLibraryViewerRenderSystem(opts.libraryViewerTarget ?? null));
  const lvTarget = opts.libraryViewerTarget ?? null;
  reg.registerSystem(createOverlayVisibilitySystem({
    target: lvTarget && lvTarget.style ? (lvTarget as { style: { display: string } }) : null,
    showWhenActiveMode: LIBRARY_VIEWER_MODE_ID,
  }));
  reg.registerSystem(createBindingSwapSystem(reg, opts.bindingCatalog ?? []));
}
