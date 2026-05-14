export interface AuthConfig {
  evoAuth: {
    serviceUrl: string;
    validateEndpoint: string;
    signInEndpoint: string;
  };
}

export const getAuthConfig = (): AuthConfig => {
  return {
    evoAuth: {
      serviceUrl: process.env.EVO_AUTH_SERVICE_URL || 'http://localhost:3001',
      validateEndpoint:
        process.env.EVO_AUTH_VALIDATE_TOKEN_ENDPOINT || '/api/v1/auth/validate',
      signInEndpoint:
        process.env.EVO_AUTH_SIGN_IN_ENDPOINT || '/api/v1/auth/sign_in',
    },
  };
};

export const validateAuthConfig = (config: AuthConfig): void => {
  if (!config.evoAuth.serviceUrl) {
    throw new Error(
      'Missing required EvoAuth configuration: serviceUrl (EVO_AUTH_SERVICE_URL)',
    );
  }
};
