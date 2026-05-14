import { Injectable } from '@nestjs/common';
import * as geoip from 'geoip-lite';
import { GeoLocation } from '../interfaces';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class GeoLocationService {
  private readonly logger = new CustomLoggerService(GeoLocationService.name);

  async getLocationFromIp(ip: string): Promise<GeoLocation> {
    if (!ip || !this.isValidPublicIp(ip)) {
      this.logger.debug(`Invalid or private IP: ${ip}`);
      return {};
    }

    try {
      const geo = geoip.lookup(ip);

      if (!geo) {
        this.logger.debug(`No geolocation found for IP: ${ip}`);
        return {};
      }

      return {
        country: geo.country,
        region: geo.region,
        city: geo.city,
        latitude: geo.ll?.[0],
        longitude: geo.ll?.[1],
        timezone: geo.timezone,
      };
    } catch (error) {
      this.logger.error(`Geolocation error for IP ${ip}: ${error.message}`);
      return {};
    }
  }

  isValidPublicIp(ip: string): boolean {
    if (!ip) return false;

    // Skip local/private IPs
    if (
      ip.startsWith('127.') ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      ip.startsWith('172.') ||
      ip === '::1' ||
      ip.startsWith('fe80')
    ) {
      return false;
    }

    return true;
  }
}
