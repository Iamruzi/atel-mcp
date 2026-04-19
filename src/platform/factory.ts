import type { AtelMcpConfig } from '../config.js';
import type { AtelSession } from '../auth/types.js';
import { PlatformClient } from './client.js';

export interface PlatformClientFactory {
  create(session: AtelSession): PlatformClient;
}

export class DefaultPlatformClientFactory implements PlatformClientFactory {
  constructor(private readonly config: AtelMcpConfig) {}
  create(_session: AtelSession): PlatformClient {
    return new PlatformClient(this.config);
  }
}
