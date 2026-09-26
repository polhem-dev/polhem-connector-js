# @polhem/connector

[English](README.md)

[![CI](https://github.com/polhem-dev/polhem-connector-js/actions/workflows/ci.yml/badge.svg)](https://github.com/polhem-dev/polhem-connector-js/actions/workflows/ci.yml)

[Polhem](https://github.com/polhem-dev/polhem) JSON-RPC API 的 JavaScript／TypeScript connector，
包含**加密**的 payload 管線。

## 狀態

**可用，尚未到 1.0。** 每一層都已實作，並以 .NET 伺服端驗證過：密碼學管線對照伺服端產生的 payload，
codec 對照伺服端公開的 wire fixtures，整個堆疊則對執行中的 host 做端到端驗證。1.0 之前 API 仍可能變動。

| 層 | 狀態 |
|----|------|
| AES-CBC-HMAC、gzip、位元組工具 | ✅ 已實作，與 .NET 的輸出交叉驗證 |
| RSA 交握 | ✅ 已實作，雙向交叉驗證 |
| JSON body codec（wire value 封套） | ✅ 以框架的 wire fixtures 驗證 |
| JSON-RPC transport（封套、管線、HTTP） | ✅ |
| 具型別的 connector（`login`、`getList`…） | ✅ |
| API 合約型別，由框架產生 | ✅ 已同步，CI 檢查 |

## 為什麼有這個套件

框架預設的 body codec 是 MessagePack，由逐型別手寫的 formatter 組成。在另一種語言裡照抄一份，
等於替同一份合約建立第二個權威來源，而且沒有任何機制能發現兩者分歧。因此伺服端接受 **JSON body codec**，
瀏覽器端只用平台 API 就能產生——本套件就是那個客戶端。

這裡所有密碼學都是 Web Crypto：AES-256-CBC、HMAC-SHA256、RSA-OAEP（SHA-256），加上平台內建的 gzip stream。
沒有重新實作任何密碼學演算法。

> 如果你的部署可以接受以 HTTPS 作為信任界線，可能根本不需要這個套件——伺服端也接受走 HTTPS 的純 JSON，
> 不需要任何客戶端函式庫。見框架 repo 的
> [ADR-014](https://github.com/polhem-dev/polhem/blob/main/docs/adr/adr-014-jsonrpc-plain-public-default.zh-TW.md)。

## 需求

任何具備 Web Crypto 與 `CompressionStream` 的執行環境：現行瀏覽器，或 Node 18 以上。

## 安裝

**本套件尚未發佈到 npm。** 請從原始碼建置：

```sh
git clone https://github.com/polhem-dev/polhem-connector-js.git
cd polhem-connector-js
npm ci
npm run build
npm pack   # 印出 tarball 名稱 polhem-connector-<version>.tgz
```

再把這個 tarball 安裝到你的專案：

```sh
npm install /path/to/polhem-connector-js/polhem-connector-<version>.tgz
```

目前無法以 Git 網址安裝：建置產物不入版控，也沒有 `prepare` script，裝好的套件會沒有 `dist`。

tarball 內的套件名稱是 `@polhem/connector`，所以下面的 import 會解析到它。

## 使用方式

```ts
import { PolhemClient } from '@polhem/connector';

const client = new PolhemClient({ endpoint: 'https://host/api', apiKey: '…' });

// Signs in, completes the RSA handshake, and installs the session key.
// Every call after this encrypts without being asked.
await client.system.login('demo', 'secret');

const employees = await client.form('Employee').getList({ selectFields: 'sys_id,sys_name' });

await client.system.logout();
```

filter 裡的值在伺服端是 `object` 型別，所以 JavaScript 分辨不出來的值要加上標記——沒標記的 decimal
會以字串抵達：

```ts
import { wire } from '@polhem/connector';

await client.form('Employee').getList({
  filter: {
    kind: 'Group',
    operator: 'And',
    nodes: [{ kind: 'Condition', fieldName: 'amount', operator: 'GreaterThan', value: wire.decimal('100') }],
  },
});
```

## 開發

```sh
npm install
npm test          # vitest，離線
npm run typecheck # tsc --noEmit
npm run build     # tsup（JS）+ tsc（宣告檔）
npm run test:wire # 下載框架的 wire fixtures，再以它們驗證 codec
```

`npm test` 完全不連網：wire 相容性以 .NET 實作產生的固定向量檢查。`npm run test:wire` 是範圍更廣的檢查——
它下載框架公開的 wire fixtures，除了 `value-datatable` 之外的 value 樣本逐一做 round-trip；`value-datatable` 則斷言解碼 `DataTable` 會被拒絕，因為目前尚未支援。這些 fixtures **不入本 repo 的版控**；
複製一份就成了 wire 格式的第二個權威來源，而且會漂移。

### 對真實後端測試

本 repo 不含伺服端。要端到端驗證 connector，請啟動 [polhem](https://github.com/polhem-dev/polhem)
repo 的 quick-start host：

```sh
# 終端機 1 — 在 polhem 的 checkout 裡
cd samples/QuickStart.Server && dotnet run

# 終端機 2 — 在這裡
npm run smoke
```

`npm run smoke` 呼叫 `System.Ping` 三次：以 Plain payload、經 JSON codec 編碼、以及透過具型別的 `client.system.ping()`。重要的是編碼的那一次——
body 在這裡產生、gzip，由伺服端的 `json` codec 解碼，並以同一個 codec 回應。

注意單元測試**不**需要伺服端：wire 相容性以 .NET 實作產生的固定向量驗證，所以 `npm test` 可離線執行。

## 授權

MIT
