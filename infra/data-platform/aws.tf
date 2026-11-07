# The Data Platform's AWS resources. None today: the inventory database moved back to Azure.
# The provider stays so Terraform can remove what this root created in AWS; the payment
# authorization service is added here next.

locals {
  aws = local.environment.aws
}

provider "aws" {
  region = local.aws.region

  default_tags {
    tags = { product = "moonshot-fest", managedBy = "terraform", team = "dataplatform" }
  }
}