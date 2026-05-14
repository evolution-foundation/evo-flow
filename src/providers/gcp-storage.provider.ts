import { Injectable } from '@nestjs/common';
import { GetSignedUrlConfig, Storage } from '@google-cloud/storage';

@Injectable()
export class GcpStorageProvider {
  private storage: Storage;

  constructor() {
    const options = {
      credentials: JSON.parse(process.env.SERVICE_ACCOUNT || '{}'),
    };

    this.storage = new Storage(options);
  }

  async generateUploadUrl(
    filename: string,
    contentType: string,
  ): Promise<{ url: string; name: string; publicUrl: string }> {
    if (!filename || !contentType) {
      throw new Error('Filename and ContentType are required.');
    }
    const expiresInFifteenMinutes = Date.now() + 15 * 60 * 1000;
    const extractedFilename = filename.split('/').pop();
    const folders = filename.split('/').slice(0, -1).join('/');
    const uniqueFilename = `${folders}/${Date.now()}-${extractedFilename}`;
    const options = {
      version: 'v4',
      action: 'write',
      contentType: contentType,
      expires: expiresInFifteenMinutes,
    } as GetSignedUrlConfig;

    if (!process.env.GCS_BUCKET_NAME) {
      throw new Error(
        'GCS_BUCKET_NAME is not defined in the environment variables.',
      );
    }

    try {
      const [url] = await this.storage
        .bucket(process.env.GCS_BUCKET_NAME)
        .file(uniqueFilename)
        .getSignedUrl(options);

      return {
        url: url,
        name: uniqueFilename,
        publicUrl: `https://${process.env.GCS_BUCKET_NAME}/${uniqueFilename}`,
      };
    } catch (error) {
      console.error('Error generating signed URL:', error);
      throw new Error('Could not generate upload URL.');
    }
  }
}
