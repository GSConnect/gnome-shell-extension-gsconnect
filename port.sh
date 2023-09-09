find . -type f -exec sed -i -E 's-(const|let|var) (.*) = *imports\.gi\.(.*);-import * as \2 from gi://3;-g' {} +
find . -type f -name "*.js" -exec sed -i -E 's-^.*imports.*$-\0 //todo port import-g' {} +
find . -type f -name "*.js" -exec sed -i -E 's-const (.*) = Extension\.imports\.([^.]*)\.?([^.]+)?;.*$-import * as \1 from "./\2/\3.js";-g' {} +
