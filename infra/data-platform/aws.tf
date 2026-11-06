# Data Platform's AWS resources: the inventory database on Amazon RDS for PostgreSQL.
# GitHub Actions signs in with the moonshot-github-dataplatform role; the data-platform-api signs in
# with the moonshot-dataplatform-api role through its Azure managed identity. Both roles come from
# infra/aws-bootstrap.yaml.

locals {
  aws                = local.environment.aws
  rds_identifier     = "moonshot-inventory"
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
  tags              = { Name = "snet-moonshot-database-${count.index + 1}" }
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

resource "aws_db_subnet_group" "inventory" {
  name       = local.rds_identifier
  subnet_ids = aws_subnet.database[*].id
}

resource "aws_security_group" "inventory" {
  name        = local.rds_identifier
  description = "PostgreSQL from the data-platform-api only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "api" {
  for_each          = local.api_outbound_cidrs
  security_group_id = aws_security_group.inventory.id
  description       = "data-platform-api outbound address"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
}

resource "aws_db_parameter_group" "inventory" {
  name   = "${local.rds_identifier}-pg16"
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

resource "aws_cloudwatch_log_group" "inventory" {
  name              = "/aws/rds/instance/${local.rds_identifier}/postgresql"
  retention_in_days = 7
}

# Prices, inventory, and reservations. Smallest single-AZ instance; the administrator password is
# generated and kept by RDS in Secrets Manager and is used only to create the IAM database user.
resource "aws_db_instance" "inventory" {
  identifier                          = local.rds_identifier
  engine                              = "postgres"
  engine_version                      = "16"
  instance_class                      = "db.t4g.micro"
  allocated_storage                   = 20
  storage_type                        = "gp3"
  storage_encrypted                   = true
  db_name                             = "inventory"
  username                            = "moonshot_admin"
  manage_master_user_password         = true
  iam_database_authentication_enabled = true
  db_subnet_group_name                = aws_db_subnet_group.inventory.name
  vpc_security_group_ids              = [aws_security_group.inventory.id]
  parameter_group_name                = aws_db_parameter_group.inventory.name
  publicly_accessible                 = true
  multi_az                            = false
  backup_retention_period             = 1
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  performance_insights_enabled        = false
  auto_minor_version_upgrade          = true
  apply_immediately                   = true
  skip_final_snapshot                 = true
  deletion_protection                 = false

  depends_on = [aws_cloudwatch_log_group.inventory, aws_route_table_association.database]
}

# The data-platform-api's AWS role may sign in as the IAM database user, and read the administrator
# secret once to create that user.
resource "aws_iam_role_policy" "api_inventory" {
  name = "inventory-access"
  role = local.runtime_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "rds-db:connect"
        Resource = "arn:aws:rds-db:${local.aws.region}:${local.aws.accountId}:dbuser:${aws_db_instance.inventory.resource_id}/${local.rds_user}"
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_db_instance.inventory.master_user_secret[0].secret_arn
      },
    ]
  })
}

output "rds_endpoint" {
  value = aws_db_instance.inventory.address
}
