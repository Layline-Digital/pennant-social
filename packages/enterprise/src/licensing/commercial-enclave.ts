/**
 * @file packages/enterprise/src/licensing/commercial-enclave.ts
 * @license Proprietary - Layline Digital LLC
 *
 * Evaluates commercial serial leases and time-gated community beta status.
 */

export interface LicenseFeatures {
  unlimitedLocalProfiles: boolean;
  walQueuePersistence: boolean;
  mediaAirlock: boolean;
  cloudMultiWorkstationSync: boolean;
  headlessDaemonWorker: boolean;
  wormAuditLogging: boolean;
}

export interface LicenseStatus {
  active: boolean;
  tier: 'COMMUNITY_BETA_FULL' | 'COMMUNITY_OPEN_CORE' | 'DESKTOP_SOLO' | 'CLOUD_FLEET';
  expiresAt: string | null;
  features: LicenseFeatures;
}

export class CommercialLicenseEnclave {
  // Public Beta sunset timestamp: December 31, 2026 23:59:59 UTC
  private static BETA_SUNSET = new Date('2026-12-31T23:59:59Z');

  async verifyLicense(key?: string): Promise<LicenseStatus> {
    const rawKey = key || (typeof localStorage !== 'undefined' ? localStorage.getItem('pennant_license_key') : '');

    // 1. Explicit Serial Key Activation (Stripe Commercial Pass)
    if (rawKey && rawKey.trim()) {
      const cleanKey = rawKey.trim();
      const isFleet = cleanKey.startsWith('PH-FLEET-');
      const isDesktop = cleanKey.startsWith('PH-DESKTOP-') || cleanKey.startsWith('PH-SOLO-');

      if (isFleet || isDesktop) {
        const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
        return {
          active: true,
          tier: isFleet ? 'CLOUD_FLEET' : 'DESKTOP_SOLO',
          expiresAt: expiry,
          features: {
            unlimitedLocalProfiles: true,
            walQueuePersistence: true,
            mediaAirlock: true,
            cloudMultiWorkstationSync: isFleet,
            headlessDaemonWorker: isFleet,
            wormAuditLogging: isFleet
          }
        };
      }
    }

    // 2. Time-Gated Public Beta: 100% Pro Features Unlocked for All Testers
    const now = new Date();
    if (now < CommercialLicenseEnclave.BETA_SUNSET) {
      return {
        active: true,
        tier: 'COMMUNITY_BETA_FULL',
        expiresAt: CommercialLicenseEnclave.BETA_SUNSET.toISOString(),
        features: {
          unlimitedLocalProfiles: true,
          walQueuePersistence: true,
          mediaAirlock: true,
          cloudMultiWorkstationSync: true,
          headlessDaemonWorker: true,
          wormAuditLogging: true
        }
      };
    }

    // 3. Post-Beta Fallback (Standard Open Core)
    return {
      active: false,
      tier: 'COMMUNITY_OPEN_CORE',
      expiresAt: null,
      features: {
        unlimitedLocalProfiles: true,
        walQueuePersistence: true,
        mediaAirlock: true,
        cloudMultiWorkstationSync: false,
        headlessDaemonWorker: false,
        wormAuditLogging: false
      }
    };
  }
}
