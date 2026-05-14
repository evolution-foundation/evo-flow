declare module 'passport-custom' {
  import { Request } from 'express';
  import { Strategy as PassportStrategy } from 'passport';

  export interface VerifyFunction {
    (req: Request, done: (error: any, user?: any) => void): void;
  }

  export interface VerifyFunctionWithRequest {
    (req: Request, done: (error: any, user?: any) => void): void;
  }

  export class Strategy extends PassportStrategy {
    constructor(verify: VerifyFunction);
    constructor(options: any, verify: VerifyFunction);
  }
}