/**
 * vi.mock factory target for '../../provider-runtime/pi-adapter.js'.
 *
 * The production runtime factory (provider-runtime/factory.js) imports the
 * Pi provider constructors (createOpenRouterPiRuntime, createOpenAIPiRuntime,
 * createOpenAICompatiblePiRuntime) from pi-adapter.js. In the conformance
 * harness, the Pi driver installs a scripted replacement for those
 * constructors (installPiFactory): each factory call returns the driver's
 * faux PiAgentRuntime for the task. Everything else the module exports
 * (PiAgentRuntime, createFauxPiRuntime, the continuation converters) stays
 * REAL — the harness runs the production Pi adapter end to end; only the
 * model behind it is scripted.
 */
export const piMockState = {
  factory: null,
};

export function installPiFactory(factory) {
  piMockState.factory = factory;
}

export function resetPiFactory() {
  piMockState.factory = null;
}

/** A provider constructor that hands the app's options to the active driver. */
export function scriptedPiFactory(providerName) {
  return (options) => {
    if (!piMockState.factory) {
      throw new Error('conformance: pi adapter factory called before a driver was installed');
    }
    return piMockState.factory(options, providerName);
  };
}
