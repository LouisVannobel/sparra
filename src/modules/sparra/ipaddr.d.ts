declare module 'ipaddr.js' {
  interface Address {
    kind(): 'ipv4' | 'ipv6'
    range(): string
    match(other: Address, bits: number): boolean
  }

  const ipaddr: {
    isValid(value: string): boolean
    parse(value: string): Address
  }

  export = ipaddr
}
