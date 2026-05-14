import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

export function IsOptionalEmail(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isOptionalEmail',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: any) {
          // Se o valor é undefined, null ou string vazia, é válido (opcional)
          if (value === undefined || value === null || value === '') {
            return true;
          }

          // Se tem valor, deve ser um email válido
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          return typeof value === 'string' && emailRegex.test(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid email address`;
        },
      },
    });
  };
}
