# 🐳 EVO CAMPAIGN - Docker Services

Este diretório contém os serviços de infraestrutura necessários para o evo-campaign em diferentes modos de execução.

## 🚀 Serviços Disponíveis

- **ClickHouse**: Database analítico para armazenamento de eventos
- **Redis**: Cache e filas para processamento assíncrono
- **RabbitMQ**: Message broker para filas robustas
- **Kafka**: Streaming platform para alta escala

## 📋 Como Usar

### Iniciar todos os serviços:
```bash
cd docker
docker-compose up -d
```

### Iniciar apenas ClickHouse (recomendado):
```bash
cd docker
docker-compose -f docker-compose.clickhouse.yml up -d
```

### Iniciar ClickHouse específico da stack completa:
```bash
cd docker
docker-compose up -d clickhouse
```

### Iniciar apenas Redis:
```bash
cd docker
docker-compose up -d redis
```

### Verificar status:
```bash
docker-compose ps
```

### Parar todos os serviços:
```bash
docker-compose down
```

## 🔗 URLs de Acesso

- **ClickHouse HTTP**: http://localhost:8123
- **ClickHouse Native**: localhost:9000
- **Redis**: localhost:6379
- **RabbitMQ Management**: http://localhost:15672 (admin/admin123)
- **Kafka**: localhost:9092
- **Kafka UI**: http://localhost:8080

## 🧪 Testando Conexões

### ClickHouse:
```bash
curl "http://localhost:8123/?query=SELECT version()"
```

### Redis:
```bash
redis-cli -h localhost -p 6379 ping
```

### RabbitMQ:
```bash
curl -u admin:admin123 http://localhost:15672/api/overview
```

## 📊 Dados Persistentes

Os dados são salvos em volumes Docker:
- `clickhouse_data`
- `redis_data` 
- `rabbitmq_data`
- `kafka_data`
- `zookeeper_data`

## 🔧 Configurações

Cada serviço tem sua pasta de configuração:
- `clickhouse/` - Configurações do ClickHouse
- `redis/` - Configurações do Redis
- `rabbitmq/` - Configurações do RabbitMQ