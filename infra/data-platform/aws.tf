# The Data Platform's AWS resources: the core database on Amazon RDS for PostgreSQL. It holds prices,
# inventory, reservations, and Moonshot Wallet balances and transactions.
# GitHub Actions signs in with the moonshot-github-dataplatform role; the data-platform-api signs in
# with the moonshot-dataplatform-api role through its Azure managed identity. Both roles come from
# infra/aws-bootstrap.yaml.

locals {
  aws                = local.environment.aws
  rds_identifier     = "rds-moonshot-core"
  rds_database       = "core"
  rds_user           = "dataplatform_api"
  runtime_role_name  = element(split("/", local.aws.dataPlatformRuntimeRole), 1)
  api_outbound_cidrs = toset([for ip in split(",", azurerm_linux_web_app.api.possible_outbound_ip_addresses) : "${trimspace(ip)}/32"])
}

provider "aws" {
  region = local.aws.region

  default_tags {
    tags = { product = "moonshot-fest", managedBy = "terraform", team = "dataplatform" }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

# Public subnets keep costs down (no NAT gateway). The security group admits only the
# data-platform-api's outbound addresses, and RDS requires TLS and IAM sign-in.
resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-moonshot-dataplatform" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "igw-moonshot-dataplatform" }
}

resource "aws_subnet" "database" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "snet-moonshot-core-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "rt-moonshot-dataplatform" }

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "database" {
  count          = 2
  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_db_subnet_group" "core" {
  name       = "dbsubnet-moonshot-core"
  subnet_ids = aws_subnet.database[*].id
}

resource "aws_security_group" "core" {
  # AWS reserves the sg- prefix for group IDs, so the console name lives in the Name tag.
  name        = "moonshot-core"
  description = "PostgreSQL from the data-platform-api only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "sg-moonshot-core" }
}

resource "aws_vpc_security_group_ingress_rule" "api" {
  for_each          = local.api_outbound_cidrs
  security_group_id = aws_security_group.core.id
  description       = "data-platform-api outbound address"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
}

resource "aws_db_parameter_group" "core" {
  name   = "pg-moonshot-core-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

resource "aws_cloudwatch_log_group" "core" {
  name              = "/aws/rds/instance/${local.rds_identifier}/postgresql"
  retention_in_days = 7
}

# Smallest single-AZ instance. The administrator password is generated and kept by RDS in Secrets
# Manager and is used only to create the IAM database user.
resource "aws_db_instance" "core" {
  identifier                          = local.rds_identifier
  engine                              = "postgres"
  engine_version                      = "16"
  instance_class                      = "db.t4g.micro"
  allocated_storage                   = 20
  storage_type                        = "gp3"
  storage_encrypted                   = true
  db_name                             = local.rds_database
  username                            = "moonshot_admin"
  manage_master_user_password         = true
  iam_database_authentication_enabled = true
  db_subnet_group_name                = aws_db_subnet_group.core.name
  vpc_security_group_ids              = [aws_security_group.core.id]
  parameter_group_name                = aws_db_parameter_group.core.name
  publicly_accessible                 = true
  multi_az                            = false
  backup_retention_period             = 1
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  performance_insights_enabled        = false
  auto_minor_version_upgrade          = true
  apply_immediately                   = true
  skip_final_snapshot                 = true
  deletion_protection                 = false

  depends_on = [aws_cloudwatch_log_group.core, aws_route_table_association.database]
}

# The data-platform-api's AWS role may sign in as the IAM database user, and read the administrator
# secret to create the database users.
resource "aws_iam_role_policy" "api_core" {
  name = "core-database-access"
  role = local.runtime_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # The API's own user, and the administrator for database setup while older setup code had left
        # the administrator able to sign in only with IAM (database setup restores its password).
        Effect = "Allow"
        Action = "rds-db:connect"
        Resource = [
          for user in [local.rds_user, aws_db_instance.core.username] :
          "arn:aws:rds-db:${local.aws.region}:${local.aws.accountId}:dbuser:${aws_db_instance.core.resource_id}/${user}"
        ]
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_db_instance.core.master_user_secret[0].secret_arn
      },
    ]
  })
}

output "rds_endpoint" {
  value = aws_db_instance.core.address
}