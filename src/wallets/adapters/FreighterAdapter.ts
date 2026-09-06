/**
 * FreighterAdapter — Adapter for the Freighter wallet extension.
 */

import type { WalletAdapter } from "../../types.js";
import { FreighterNotInstalledError } from "../../errors.js";

type Unsubscribe = () => void;

declare global {
  interface Window {
    freighter?: {
      isConnected(): Promise<boolean>;
      getPublicKey(): Promise<string>;
      signTransaction(xdr: string, network: string): Promise<string>;
    };
  }
}

type FreighterApi = NonNullable<Window["freighter"]>;

/**
 * Resolve the injected Freighter API, or `undefined` when it is unavailable.
 *
 * `window` itself is checked with `typeof` first: in SSR, Node and worker
 * contexts a bare `window` reference throws before any property access, which
 * is the raw crash callers were seeing instead of an actionable error.
 */
function getFreighter(): FreighterApi | undefined {
  if (typeof window === "undefined") return undefined;
  return window.freighter;
}

/** Resolve the injected Freighter API, or throw {@link FreighterNotInstalledError}. */
function requireFreighter(): FreighterApi {
  const freighter = getFreighter();
  if (!freighter) {
    throw new FreighterNotInstalledError();
  }
  return freighter;
}

export class FreighterAdapter implements WalletAdapter {
  readonly name = "Freighter";
  private accountChangeHandlers: Array<(address: string) => void> = [];
  private pollInterval: NodeJS.Timeout | null = null;
  private lastKnownAddress: string | null = null;

  async connect(): Promise<string> {
    const freighter = requireFreighter();

    const address = await freighter.getPublicKey();
    this.lastKnownAddress = address;
    
    // Start polling for account changes (Freighter doesn't have a native event)
    this.startAccountChangePolling();
    
    return address;
  }

  async sign(xdr: string, network: string): Promise<string> {
    const freighter = requireFreighter();

    return await freighter.signTransaction(xdr, network);
  }

  async getAddress(): Promise<string> {
    const freighter = requireFreighter();

    return await freighter.getPublicKey();
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    return this.sign(xdr, network);
  }

  disconnect(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.accountChangeHandlers = [];
    this.lastKnownAddress = null;
  }

  onAccountChange(handler: (address: string) => void): Unsubscribe {
    this.accountChangeHandlers.push(handler);
    
    return () => {
      const index = this.accountChangeHandlers.indexOf(handler);
      if (index > -1) {
        this.accountChangeHandlers.splice(index, 1);
      }
    };
  }

  private startAccountChangePolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      try {
        const freighter = getFreighter();
        if (!freighter) return;
        
        const currentAddress = await freighter.getPublicKey();
        
        if (currentAddress !== this.lastKnownAddress) {
          this.lastKnownAddress = currentAddress;
          for (const handler of this.accountChangeHandlers) {
            try {
              handler(currentAddress);
            } catch (err) {
              console.error("Error in account change handler:", err);
            }
          }
        }
      } catch (err) {
        // Wallet might be locked or disconnected
        console.warn("Error polling Freighter account:", err);
      }
    }, 2000); // Poll every 2 seconds
  }
}
