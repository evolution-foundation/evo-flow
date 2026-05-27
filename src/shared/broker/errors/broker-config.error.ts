export class BrokerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerConfigError';
  }
}

export class BrokerNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerNotImplementedError';
  }
}
