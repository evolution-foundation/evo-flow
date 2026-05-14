/**
 * Minimal User DTO returned by evo-auth-service-community REST API.
 */
export interface UserDto {
  id: string;
  name: string;
  email: string;
  role?: {
    name: string;
    permissions: string[];
  };
}
