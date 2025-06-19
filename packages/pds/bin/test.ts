#!/usr/bin/env ts-node
import  * as xrpc from '@atproto/xrpc';

export async function main() {
  const client = new xrpc.XrpcClient();

  client.call("")
}

main()
