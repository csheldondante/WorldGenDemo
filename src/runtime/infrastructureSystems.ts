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
import type { BufferId } from "./buffer";
import type { SystemDescriptor } from "./system";
import type { ControllerBinding } from "./moduleSlots";
import {
  createLibraryViewerBuffer,
  createLibraryViewerSystem,
  createLibraryViewerRenderSystem,
  LIBRARY_VIEWER_MODE_ID,
  type LibraryViewerRenderTarget,
} from "./libraryViewer";
import { createBindingSwapSystem } from "./bindingSwapSystem";
import { createOverlayVisibilitySystem, type OverlayBinding } from "./overlayVisibility";

export interface InfrastructureOptions {
  /** DOM panel for the Library Viewer renderer + overlay visibility
   *  toggle. Null = both systems become no-ops. */
  libraryViewerTarget?: LibraryViewerRenderTarget | null;
  /** Catalog of character bindings the BindingSwapSystem looks up by id
   *  on BindingRequested events. Defaults to empty (= no-op on every
   *  request; tests that don't exercise bindings can omit). */
  bindingCatalog?: ControllerBinding[];
  /** Function that applies a binding to runtime buffers. Caller-injected
   *  so this runtime-layer helper stays buffer-type-agnostic. Defaults
   *  to a no-op. */
  applyBinding?: (binding: ControllerBinding) => void;
  /** Buffer ids the `applyBinding` callback writes to. Declared in the
   *  BindingSwapSystem's access list for hazard validation. */
  bindingWriteBufferIds?: BufferId[];
  /** System ids that read the destination buffers; BindingSwapSystem
   *  declares runsBefore on each so the swap is visible this tick. */
  bindingReaderSystemIds?: string[];
  /** Extra systems to register alongside the core infrastructure
   *  (= app-layer systems referenced by core graphs, e.g.
   *  transitionActivatorSystem). Caller supplies the descriptors
   *  since they often live in src/app/ which the runtime layer
   *  cannot import directly. */
  extraSystems?: SystemDescriptor[];
  /** Additional overlay panels to manage. Each binding is shown when
   *  its `modeId` matches activeMode. Useful for app-specific overlays
   *  (= ProfileEditor) layered on the runtime's LibraryViewer. */
  extraOverlays?: OverlayBinding[];
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
  reg.registerBuffer(createLibraryViewerBuffer());
  reg.registerSystem(createLibraryViewerSystem(reg));
  reg.registerSystem(createLibraryViewerRenderSystem(opts.libraryViewerTarget ?? null));
  const lvTarget = opts.libraryViewerTarget ?? null;
  reg.registerSystem(createOverlayVisibilitySystem({
    bindings: [
      {
        modeId: LIBRARY_VIEWER_MODE_ID,
        target: lvTarget && lvTarget.style ? (lvTarget as { style: { display: string } }) : null,
      },
      ...(opts.extraOverlays ?? []),
    ],
  }));
  reg.registerSystem(createBindingSwapSystem({
    catalog: opts.bindingCatalog ?? [],
    apply: opts.applyBinding ?? (() => { /* no-op when no installer provided */ }),
    writeBufferIds: opts.bindingWriteBufferIds ?? [],
    runsBefore: opts.bindingReaderSystemIds,
  }));
  if (opts.extraSystems) {
    for (const sys of opts.extraSystems) reg.registerSystem(sys);
  }
}
