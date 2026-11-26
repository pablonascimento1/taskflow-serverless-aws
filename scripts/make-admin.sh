#!/usr/bin/env bash
# Coloca um usuário já cadastrado no grupo "admin" do Cognito.
#   bash scripts/make-admin.sh email@exemplo.com
# O usuário precisa sair e entrar de novo para o novo papel valer (vem dentro do token).
set -euo pipefail
EMAIL="${1:?Uso: bash scripts/make-admin.sh email@exemplo.com}"
STACK="${STACK:-taskflow}"
REGION="${AWS_REGION:-us-east-1}"

POOL=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue | [0]" --output text)

aws cognito-idp admin-add-user-to-group --region "$REGION" \
  --user-pool-id "$POOL" --username "$EMAIL" --group-name admin

echo "OK: $EMAIL agora é admin. Saia e entre novamente no site."
