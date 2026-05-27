export class BrokerNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerNotImplementedError';
  }
}
