find . -type f -exec sed -i -E 's-(const|let|var) (.*) = *imports\.gi\.(.*);-import * as \2 from gi://3;-g' {} +
find . -type f -name "*.js" -exec sed -i -E 's-^.*imports.*569JXZims //todo port import-g' {} +
