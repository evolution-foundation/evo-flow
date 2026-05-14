import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditLogFiltersDto } from './dto/audit-log-filters.dto';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { Role } from 'src/auth/enums/roles.enum';

@ApiTags('Audit')
@Controller('audits')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class AuditController {
    constructor(private readonly auditService: AuditService) {}

    @Get('')
    @Roles(Role.ADMIN, Role.MASTER_ADMIN)
    @ApiOperation({ summary: 'Search audit logs' })
    @ApiResponse({ status: 200, description: 'Returns filtered audit logs' })
    async findAuditLogs(@Query() filters: AuditLogFiltersDto) {
        return this.auditService.findAuditLogs(filters);
    }
} 