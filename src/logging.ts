// Logger handed to the SDK: warnings and errors always, routine INFO/DEBUG
// chatter only with PDSYNC_VERBOSE=1. Verification and decryption failures
// are always shown, since they are about file integrity.
import { ProtonDriveClient } from '@protontech/drive-sdk';

type Telemetry = NonNullable<ConstructorParameters<typeof ProtonDriveClient>[0]['telemetry']>;

export const verbose = !!process.env.PDSYNC_VERBOSE;

const ALWAYS_SHOWN_METRICS = new Set(['decryptionError', 'verificationError', 'blockVerificationError']);

export const telemetry: Telemetry = {
    getLogger: (name) => ({
        debug: (msg) => verbose && console.log(`[${name}] ${msg}`),
        info: (msg) => verbose && console.log(`[${name}] ${msg}`),
        warn: (msg) => console.warn(`[${name}] warning: ${msg}`),
        error: (msg, error) => console.error(`[${name}] error: ${msg}`, error ?? ''),
    }),
    recordMetric: (event) => {
        if (verbose || ALWAYS_SHOWN_METRICS.has(event.eventName)) {
            console.warn(`[metric] ${JSON.stringify(event)}`);
        }
    },
};
