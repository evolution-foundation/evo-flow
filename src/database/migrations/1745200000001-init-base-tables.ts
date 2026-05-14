import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableIndex,
  TableForeignKey,
} from 'typeorm';

export class InitBaseTables1745200000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    console.log('Initializing base tables (PostgreSQL)');

    // Enable UUID extension
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    console.log('pgcrypto extension enabled');

    await this.initPostgreSQL(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Em modo híbrido, não dropar tabelas que podem ser do evo-ai-crm
    console.log(
      '⚠️  Hybrid mode: Not dropping base tables (may belong to evo-ai-crm)',
    );
  }

  private async initPostgreSQL(queryRunner: QueryRunner): Promise<void> {
    // Verificar quais tabelas já existem (modo híbrido com evo-ai-crm)
    const contactsExists = await queryRunner.hasTable('contacts');
    const customAttributeDefinitionsExists = await queryRunner.hasTable(
      'custom_attribute_definitions',
    );
    const labelsExists = await queryRunner.hasTable('labels');
    const tagsExists = await queryRunner.hasTable('tags');
    const taggingsExists = await queryRunner.hasTable('taggings');
    const segmentsExists = await queryRunner.hasTable('segments');

    if (
      contactsExists &&
      customAttributeDefinitionsExists &&
      labelsExists &&
      tagsExists &&
      taggingsExists &&
      segmentsExists
    ) {
      console.log('✅ All base tables already exist (evo-ai-crm hybrid mode)');
      return;
    }

    if (!contactsExists) {
      console.log('🔧 Creating contacts table...');
      await this.createContactsPostgreSQL(queryRunner);
    } else {
      console.log('✅ Contacts table exists');
    }

    if (!customAttributeDefinitionsExists) {
      console.log('🔧 Creating custom_attribute_definitions table...');
      await this.createCustomAttributeDefinitionsPostgreSQL(queryRunner);
    } else {
      console.log('✅ Custom_attribute_definitions table exists');
    }

    if (!labelsExists) {
      console.log('🔧 Creating labels table...');
      await this.createLabelsPostgreSQL(queryRunner);
    } else {
      console.log('✅ Labels table exists');
    }

    if (!tagsExists) {
      console.log('🔧 Creating tags table (acts_as_taggable_on)...');
      await this.createTagsPostgreSQL(queryRunner);
    } else {
      console.log('✅ Tags table exists');
    }

    if (!taggingsExists) {
      console.log('🔧 Creating taggings table (acts_as_taggable_on)...');
      await this.createTaggingsPostgreSQL(queryRunner);
    } else {
      console.log('✅ Taggings table exists');
    }

    if (!segmentsExists) {
      console.log('🔧 Creating segments table...');
      await this.createSegmentsPostgreSQL(queryRunner);
    } else {
      console.log('✅ Segments table exists');
    }

    console.log('✅ Base tables initialization complete (PostgreSQL)');
  }

  // ==================== CONTACTS TABLE ====================

  private async createContactsPostgreSQL(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'contacts',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'name', type: 'varchar', default: "''" },
          { name: 'email', type: 'varchar', isNullable: true },
          { name: 'phone_number', type: 'varchar', isNullable: true },
          {
            name: 'created_at',
            type: 'timestamp',
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
            precision: 3,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
            precision: 3,
          },
          { name: 'additional_attributes', type: 'jsonb', default: "'{}'" },
          { name: 'identifier', type: 'varchar', isNullable: true },
          { name: 'custom_attributes', type: 'jsonb', default: "'{}'" },
          {
            name: 'last_activity_at',
            type: 'timestamp',
            isNullable: true,
            precision: 3,
          },
          { name: 'contact_type', type: 'integer', default: 0 },
          { name: 'middle_name', type: 'varchar', default: "''" },
          { name: 'last_name', type: 'varchar', default: "''" },
          { name: 'location', type: 'varchar', default: "''" },
          { name: 'country_code', type: 'varchar', default: "''" },
          {
            name: 'blocked',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
          { name: 'avatar_url', type: 'varchar', isNullable: true },
          { name: 'pubsub_token', type: 'varchar', isNullable: true },
          {
            name: 'hmac_verified',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
        ],
      }),
    );

    // Verificar se extensão pg_trgm existe (necessária para trigram search)
    try {
      await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    } catch {
      console.log(
        '⚠️  pg_trgm extension not available, skipping trigram indexes',
      );
    }

    // Indexes (single-account)
    const contactsIndexes = [
      new TableIndex({
        name: 'index_contacts_on_last_activity_at',
        columnNames: ['last_activity_at'],
      }),
      new TableIndex({
        name: 'index_contacts_on_blocked',
        columnNames: ['blocked'],
      }),

      // JSONB indexes - using SQL for GIN
      // Note: GIN indexes will be created via raw SQL below

      // Unique constraints
      // Note: Unique index for email will be created via SQL to handle NULLs properly
      new TableIndex({
        name: 'uniq_identifier_contact',
        columnNames: ['identifier'],
        isUnique: true,
      }),
    ];

    for (const index of contactsIndexes) {
      await queryRunner.createIndex('contacts', index);
    }

    // Indexes GIN para JSONB
    await queryRunner.query(`
            CREATE INDEX index_contacts_on_custom_attributes 
            ON contacts USING gin (custom_attributes);
        `);

    await queryRunner.query(`
            CREATE INDEX index_contacts_on_additional_attributes 
            ON contacts USING gin (additional_attributes);
        `);

    // Index com ordering específico
    await queryRunner.query(`
            CREATE INDEX index_contacts_on_last_activity_at_desc
            ON contacts (last_activity_at DESC NULLS LAST);
        `);

    // Indexes complexos via SQL raw
    await queryRunner.query(`
            CREATE INDEX index_contacts_on_lower_email
            ON contacts (lower((email)::text));
        `);

    await queryRunner.query(`
            CREATE INDEX index_contacts_on_nonempty_fields
            ON contacts (email, phone_number, identifier)
            WHERE (((email)::text <> ''::text) OR ((phone_number)::text <> ''::text) OR ((identifier)::text <> ''::text));
        `);

    await queryRunner.query(`
            CREATE INDEX index_resolved_contact
            ON contacts (id)
            WHERE (((email)::text <> ''::text) OR ((phone_number)::text <> ''::text) OR ((identifier)::text <> ''::text));
        `);

    // Unique index para email que permite NULLs
    await queryRunner.query(`
            CREATE UNIQUE INDEX uniq_email_contact
            ON contacts (email)
            WHERE email IS NOT NULL AND email != '';
        `);

    // Index GIN trigram (só se pg_trgm disponível)
    try {
      await queryRunner.query(`
                CREATE INDEX index_contacts_on_name_email_phone_number_identifier 
                ON contacts USING gin (name gin_trgm_ops, email gin_trgm_ops, phone_number gin_trgm_ops, identifier gin_trgm_ops);
            `);
    } catch {
      console.log('⚠️  Trigram index creation failed, continuing without it');
    }
  }

  // ==================== CUSTOM ATTRIBUTE DEFINITIONS ====================

  private async createCustomAttributeDefinitionsPostgreSQL(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'custom_attribute_definitions',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'attribute_display_name', type: 'varchar', isNullable: true },
          { name: 'attribute_key', type: 'varchar', isNullable: true },
          { name: 'attribute_display_type', type: 'integer', default: 0 },
          { name: 'default_value', type: 'integer', isNullable: true },
          {
            name: 'attribute_model',
            type: 'integer',
            default: 0,
            comment: '0: contact, 1: conversation',
          },
          { name: 'attribute_description', type: 'text', isNullable: true },
          { name: 'attribute_values', type: 'jsonb', default: "'[]'" },
          { name: 'regex_pattern', type: 'varchar', isNullable: true },
          { name: 'regex_cue', type: 'varchar', isNullable: true },
          {
            name: 'created_at',
            type: 'timestamp',
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
            precision: 3,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
            precision: 3,
          },
        ],
      }),
    );

    // Indexes para custom_attribute_definitions (single-account)
    const customAttrIndexes = [
      new TableIndex({
        name: 'attribute_key_model_index',
        columnNames: ['attribute_key', 'attribute_model'],
        isUnique: true,
      }),
    ];

    for (const index of customAttrIndexes) {
      await queryRunner.createIndex('custom_attribute_definitions', index);
    }
  }

  // ==================== LABELS TABLE ====================

  private async createLabelsPostgreSQL(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'labels',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'title', type: 'varchar', isNullable: true },
          { name: 'description', type: 'text', isNullable: true },
          {
            name: 'color',
            type: 'varchar',
            default: "'#1f93ff'",
            isNullable: false,
          },
          {
            name: 'show_on_sidebar',
            type: 'boolean',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
            precision: 3,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
            precision: 3,
          },
        ],
      }),
    );

    // Indexes para labels (single-account)
    const labelsIndexes = [
      new TableIndex({
        name: 'index_labels_on_title',
        columnNames: ['title'],
        isUnique: true,
      }),
    ];

    for (const index of labelsIndexes) {
      await queryRunner.createIndex('labels', index);
    }
  }

  // ==================== TAGS TABLE (acts_as_taggable_on) ====================

  private async createTagsPostgreSQL(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'tags',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'name', type: 'varchar', isNullable: false },
          {
            name: 'taggings_count',
            type: 'integer',
            default: 0,
            isNullable: false,
          },
        ],
      }),
    );

    // Index único para nome da tag
    const tagsIndexes = [
      new TableIndex({
        name: 'index_tags_on_name',
        columnNames: ['name'],
        isUnique: true,
      }),
    ];

    for (const index of tagsIndexes) {
      await queryRunner.createIndex('tags', index);
    }
  }

  // ==================== TAGGINGS TABLE (acts_as_taggable_on) ====================

  private async createTaggingsPostgreSQL(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'taggings',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'tag_id', type: 'uuid', isNullable: false },
          { name: 'taggable_type', type: 'varchar', isNullable: false },
          { name: 'taggable_id', type: 'uuid', isNullable: false },
          { name: 'tagger_type', type: 'varchar', isNullable: true },
          { name: 'tagger_id', type: 'uuid', isNullable: true },
          { name: 'context', type: 'varchar', length: '128', isNullable: true },
          {
            name: 'created_at',
            type: 'timestamp',
            isNullable: true,
            precision: 3,
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
    );

    // Indexes para taggings (iguais ao evo-ai-crm acts_as_taggable_on)
    const taggingsIndexes = [
      new TableIndex({
        name: 'index_taggings_on_context',
        columnNames: ['context'],
      }),
      new TableIndex({
        name: 'index_taggings_on_tag_id',
        columnNames: ['tag_id'],
      }),
      new TableIndex({
        name: 'index_taggings_on_taggable_id_and_taggable_type_and_context',
        columnNames: ['taggable_id', 'taggable_type', 'context'],
      }),
      new TableIndex({
        name: 'index_taggings_on_taggable_id',
        columnNames: ['taggable_id'],
      }),
      new TableIndex({
        name: 'index_taggings_on_taggable_type',
        columnNames: ['taggable_type'],
      }),
      new TableIndex({
        name: 'index_taggings_on_tagger_id_and_tagger_type',
        columnNames: ['tagger_id', 'tagger_type'],
      }),
      new TableIndex({
        name: 'index_taggings_on_tagger_id',
        columnNames: ['tagger_id'],
      }),
      new TableIndex({
        name: 'taggings_idx',
        columnNames: [
          'tag_id',
          'taggable_id',
          'taggable_type',
          'context',
          'tagger_id',
          'tagger_type',
        ],
        isUnique: true,
      }),
      new TableIndex({
        name: 'taggings_idy',
        columnNames: ['taggable_id', 'taggable_type', 'tagger_id', 'context'],
      }),
    ];

    for (const index of taggingsIndexes) {
      await queryRunner.createIndex('taggings', index);
    }
  }

  // ==================== SEGMENTS TABLE ====================

  private async createSegmentsPostgreSQL(
    queryRunner: QueryRunner,
  ): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'segments',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'name', type: 'varchar', length: '255', isNullable: false },
          { name: 'definition', type: 'jsonb', isNullable: false },
          {
            name: 'status',
            type: 'varchar',
            default: "'NotStarted'",
            isNullable: false,
          },
          {
            name: 'resource_type',
            type: 'varchar',
            default: "'Declarative'",
            isNullable: false,
          },
          { name: 'subscription_group_id', type: 'uuid', isNullable: true },
          { name: 'last_computed_at', type: 'timestamp', isNullable: true },
          {
            name: 'computed_count',
            type: 'integer',
            default: 0,
            isNullable: false,
          },
          {
            name: 'contacts_count',
            type: 'integer',
            default: 0,
            isNullable: false,
          },
          {
            name: 'version',
            type: 'integer',
            default: 1,
            isNullable: false,
          },
          {
            name: 'definition_updated_at',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
            precision: 3,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
            precision: 3,
          },
        ],
      }),
    );

    // Indexes para segments (single-account)
    const segmentsIndexes = [
      new TableIndex({
        name: 'index_segments_on_name',
        columnNames: ['name'],
        isUnique: true,
      }),
      new TableIndex({
        name: 'index_segments_on_status',
        columnNames: ['status'],
      }),
      new TableIndex({
        name: 'index_segments_on_resource_type',
        columnNames: ['resource_type'],
      }),
    ];

    for (const index of segmentsIndexes) {
      await queryRunner.createIndex('segments', index);
    }

    // GIN index para JSONB definition
    await queryRunner.query(`
            CREATE INDEX index_segments_on_definition 
            ON segments USING gin (definition);
        `);
  }
}
