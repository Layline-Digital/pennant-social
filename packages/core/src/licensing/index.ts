/**
 * @file packages/core/src/licensing/index.ts
 * @license MIT
 *
 * Open Core Interface for Pennant Hoist Licensing.
 * Community Edition is 100% sovereign, perpetual, and locally unlocked.
 */

export interface LicenseStatus {
  active: boolean;
  tier: 'COMMUNITY_OPEN_CORE' | 'DESKTOP_SOLO' | 'CLOUD_FLEET';
  expiresAt: string | null;
  features: {
    unlimitedLocalProfiles: boolean;
    walQueuePersistence: boolean;
    mediaAirlock: boolean;
    cloudMultiWorkstationSync: boolean;
    headlessDaemonWorker: boolean;
    wormAuditLogging: boolean;
  };
}

export interface ILicenseEnclave {
  verifyLicense(key?: string): Promise<LicenseStatus>;
}

/**
 * Default Open Core Enclave
 * Always active with full local sovereignty.
 */
export class CommunityLicenseEnclave implements ILicenseEnclave {
  async verifyLicense(): Promise<LicenseStatus> {
    return {
      active: true,
      tier: 'COMMUNITY_OPEN_CORE',
      expiresAt: null,
      features: {
        unlimitedLocalProfiles: true,
        walQueuePersistence: true,
        mediaAirlock: true,
        cloudMultiWorkstationSync: false, // Available in Commercial Fleet Tier
        headlessDaemonWorker: false,     // Available in Commercial Cloud Tier
        wormAuditLogging: false          // Available in Commercial Enterprise
      }
    };
  }
}
