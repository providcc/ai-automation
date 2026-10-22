#!/bin/sh
# 容器入口：把常用入口映射到 node 运行方式。
#
#   docker run --rm IMAGE rc --version            # iPaaS CLI
#   docker run --rm IMAGE dw doctor               # 数仓 CLI
#   docker run --rm IMAGE scripts/verify-flow-lifecycle.mjs --allow-host <host>
#   docker run --rm IMAGE packages/cli/src/index.ts flow list
set -e

case "${1:-}" in
  rc)
    shift
    exec node --experimental-strip-types /app/packages/cli/src/index.ts "$@"
    ;;
  dw)
    shift
    exec node --experimental-strip-types /app/packages/dw-cli/src/index.ts "$@"
    ;;
  *)
    exec node --experimental-strip-types "$@"
    ;;
esac
