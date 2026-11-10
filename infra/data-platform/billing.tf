# Moonshot Billing: the Lambda function fn-moonshot-billing charges Moonshot Wallets and issues invoices
# in the core database's `billing` schema. Only the data-platform-api invokes it (no HTTP endpoint).
# Terraform owns the function's configuration; Deploy data platform uploads its code.
# Its execution role, moonshot-billing-fn, comes from infra/aws-bootstrap.yaml (IAM stays in bootstrap).

locals {
  billing_function = "fn-moonshot-billing"
  billing_db_user  = "billing_fn"
}

resource "aws_security_group" "billing" {
  # AWS reserves the sg- prefix for group IDs, so the console name lives in the Name tag.
  name        = "moonshot-billing"
  description = "fn-moonshot-billing: PostgreSQL to the core database only"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "sg-moonshot-billing" }
}

resource "aws_vpc_security_group_egress_rule" "billing_to_core" {
  security_group_id            = aws_security_group.billing.id
  description                  = "PostgreSQL to rds-moonshot-core"
  referenced_security_group_id = aws_security_group.core.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "core_from_billing" {
  security_group_id            = aws_security_group.core.id
  description                  = "fn-moonshot-billing"
  referenced_security_group_id = aws_security_group.billing.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_cloudwatch_log_group" "billing" {
  name              = "/aws/lambda/${local.billing_function}"
  retention_in_days = 7
}

# Terraform creates the function with a placeholder; the deployment workflow uploads the real bundle.
data "archive_file" "billing_placeholder" {
  type        = "zip"
  output_path = "${path.module}/.terraform/billing-placeholder.zip"

  source {
    filename = "index.js"
    content  = "exports.handler = async () => { throw new Error('fn-moonshot-billing code has not been deployed.'); };"
  }
}

resource "aws_lambda_function" "billing" {
  function_name    = local.billing_function
  description      = "Moonshot Billing: charges Moonshot Wallets and issues invoices"
  role             = "arn:aws:iam::${local.aws.accountId}:role/moonshot-billing-fn"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.billing_placeholder.output_path
  source_code_hash = data.archive_file.billing_placeholder.output_base64sha256
  memory_size      = 256
  timeout          = 10

  # In the VPC so the core database's security group can admit it; it needs nothing on the internet.
  vpc_config {
    subnet_ids         = aws_subnet.database[*].id
    security_group_ids = [aws_security_group.billing.id]
  }

  environment {
    variables = {
      DATABASE_URL  = "postgres://${local.billing_db_user}@${aws_db_instance.core.address}:5432/${aws_db_instance.core.db_name}?sslmode=require"
      DATABASE_AUTH = "aws-iam"
      # Includes the Amazon RDS certificate authorities.
      NODE_EXTRA_CA_CERTS = "/var/runtime/ca-cert.pem"
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.billing.name
  }

  lifecycle {
    # Deploy data platform uploads the code.
    ignore_changes = [filename, source_code_hash]
  }
}

# The data-platform-api's AWS role may invoke billing, and nothing else may.
resource "aws_iam_role_policy" "api_billing" {
  name = "billing-invoke"
  role = local.runtime_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.billing.arn
    }]
  })
}

output "billing_function" {
  value = aws_lambda_function.billing.function_name
}
