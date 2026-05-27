export class BrokerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerConfigError';
  }
}
