import { describe, expect, test } from "vitest";
import {
  b64Parse, b64Stringify,
  isB64, b64Sizeof,
  b64Read, b64Write,
  toZigZag, fromZigZag
} from "./rx";

describe('b64 stringify', () => {
  test('encoding b64 digits in correct order', () => {
    expect(b64Stringify(0)).toBe('');
    expect(b64Stringify(1)).toBe('1');
    expect(b64Stringify(9)).toBe('9');
    expect(b64Stringify(10)).toBe('a');
    expect(b64Stringify(35)).toBe('z');
    expect(b64Stringify(36)).toBe('A');
    expect(b64Stringify(61)).toBe('Z');
    expect(b64Stringify(62)).toBe('-');
    expect(b64Stringify(63)).toBe('_');
    expect(b64Stringify(64)).toBe('10');
  });
  test('encoding b64 as powers of 16)', () => {
    expect(b64Stringify(0x1)).toBe('1');
    expect(b64Stringify(0x10)).toBe('g');
    expect(b64Stringify(0x100)).toBe('40');
    expect(b64Stringify(0x1000)).toBe('100');
    expect(b64Stringify(0x10000)).toBe('g00');
    expect(b64Stringify(0x100000)).toBe('4000');
    expect(b64Stringify(0x1000000)).toBe('10000');
    expect(b64Stringify(0x10000000)).toBe('g0000');
    expect(b64Stringify(0x100000000)).toBe('400000');
    expect(b64Stringify(0x1000000000)).toBe('1000000');
    expect(b64Stringify(0x10000000000)).toBe('g000000');
    expect(b64Stringify(0x100000000000)).toBe('40000000');
    expect(b64Stringify(0x1000000000000)).toBe('100000000');
    expect(b64Stringify(0x10000000000000)).toBe('g00000000');
  });
  test('encoding b64 near 12, 32 and 53 bit precision limits)', () => {
    expect(b64Stringify(2 ** 16 - 5)).toBe('f_X');
    expect(b64Stringify(2 ** 16 - 4)).toBe('f_Y');
    expect(b64Stringify(2 ** 16 - 3)).toBe('f_Z');
    expect(b64Stringify(2 ** 16 - 2)).toBe('f_-');
    expect(b64Stringify(2 ** 16 - 1)).toBe('f__');
    expect(b64Stringify(2 ** 16)).toBe('g00');
    expect(b64Stringify(2 ** 16 + 1)).toBe('g01');
    expect(b64Stringify(2 ** 16 + 2)).toBe('g02');
    expect(b64Stringify(2 ** 16 + 3)).toBe('g03');
    expect(b64Stringify(2 ** 16 + 4)).toBe('g04');
    expect(b64Stringify(2 ** 32 - 5)).toBe('3____X');
    expect(b64Stringify(2 ** 32 - 4)).toBe('3____Y');
    expect(b64Stringify(2 ** 32 - 3)).toBe('3____Z');
    expect(b64Stringify(2 ** 32 - 2)).toBe('3____-');
    expect(b64Stringify(2 ** 32 - 1)).toBe('3_____');
    expect(b64Stringify(2 ** 32)).toBe('400000');
    expect(b64Stringify(2 ** 32 + 1)).toBe('400001');
    expect(b64Stringify(2 ** 32 + 2)).toBe('400002');
    expect(b64Stringify(2 ** 32 + 3)).toBe('400003');
    expect(b64Stringify(2 ** 32 + 4)).toBe('400004');
    expect(b64Stringify(2 ** 53 - 1)).toBe('v________');
    expect(b64Stringify(2 ** 53 - 2)).toBe('v_______-');
    expect(b64Stringify(2 ** 53 - 3)).toBe('v_______Z');
    expect(b64Stringify(2 ** 53 - 4)).toBe('v_______Y');
    expect(b64Stringify(2 ** 53 - 5)).toBe('v_______X');
  });
  test('fails on invalid inputs', () => {
    expect(() => b64Stringify(-1)).toThrow();
    expect(() => b64Stringify(1.5)).toThrow();
    expect(() => b64Stringify(NaN)).toThrow();
    expect(() => b64Stringify(Infinity)).toThrow();
  });
});

describe('b64 parse', () => {
  test('decoding b64 digits in correct order', () => {
    expect(b64Parse('')).toBe(0);
    expect(b64Parse('1')).toBe(1);
    expect(b64Parse('9')).toBe(9);
    expect(b64Parse('a')).toBe(10);
    expect(b64Parse('z')).toBe(35);
    expect(b64Parse('A')).toBe(36);
    expect(b64Parse('Z')).toBe(61);
    expect(b64Parse('-')).toBe(62);
    expect(b64Parse('_')).toBe(63);
    expect(b64Parse('10')).toBe(64);
  })
  test('decoding b64 as powers of 16)', () => {
    expect(b64Parse('1')).toBe(0x1);
    expect(b64Parse('g')).toBe(0x10);
    expect(b64Parse('40')).toBe(0x100);
    expect(b64Parse('100')).toBe(0x1000);
    expect(b64Parse('g00')).toBe(0x10000);
    expect(b64Parse('4000')).toBe(0x100000);
    expect(b64Parse('10000')).toBe(0x1000000);
    expect(b64Parse('g0000')).toBe(0x10000000);
    expect(b64Parse('400000')).toBe(0x100000000);
    expect(b64Parse('1000000')).toBe(0x1000000000);
    expect(b64Parse('g000000')).toBe(0x10000000000);
    expect(b64Parse('40000000')).toBe(0x100000000000);
    expect(b64Parse('100000000')).toBe(0x1000000000000);
    expect(b64Parse('g00000000')).toBe(0x10000000000000);
  });
  test('decoding b64 near 12, 32 and 53 bit precision limits)', () => {
    expect(b64Parse('f_X')).toBe(2 ** 16 - 5);
    expect(b64Parse('f_Y')).toBe(2 ** 16 - 4);
    expect(b64Parse('f_Z')).toBe(2 ** 16 - 3);
    expect(b64Parse('f_-')).toBe(2 ** 16 - 2);
    expect(b64Parse('f__')).toBe(2 ** 16 - 1);
    expect(b64Parse('g00')).toBe(2 ** 16);
    expect(b64Parse('g01')).toBe(2 ** 16 + 1);
    expect(b64Parse('g02')).toBe(2 ** 16 + 2);
    expect(b64Parse('g03')).toBe(2 ** 16 + 3);
    expect(b64Parse('g04')).toBe(2 ** 16 + 4);
    expect(b64Parse('3____X')).toBe(2 ** 32 - 5);
    expect(b64Parse('3____Y')).toBe(2 ** 32 - 4);
    expect(b64Parse('3____Z')).toBe(2 ** 32 - 3);
    expect(b64Parse('3____-')).toBe(2 ** 32 - 2);
    expect(b64Parse('3_____')).toBe(2 ** 32 - 1);
    expect(b64Parse('400000')).toBe(2 ** 32);
    expect(b64Parse('400001')).toBe(2 ** 32 + 1);
    expect(b64Parse('400002')).toBe(2 ** 32 + 2);
    expect(b64Parse('400003')).toBe(2 ** 32 + 3);
    expect(b64Parse('400004')).toBe(2 ** 32 + 4);
    expect(b64Parse('w00000000')).toBe(2 ** 53);
    expect(b64Parse('v________')).toBe(2 ** 53 - 1);
    expect(b64Parse('v_______-')).toBe(2 ** 53 - 2);
    expect(b64Parse('v_______Z')).toBe(2 ** 53 - 3);
    expect(b64Parse('v_______Y')).toBe(2 ** 53 - 4);
    expect(b64Parse('v_______X')).toBe(2 ** 53 - 5);
  });
});

describe('b64 parse/stringify', () => {
  test('random fuzzing', () => {
    for (let i = 0; i < 100000; i++) {
      const n = Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER + 2));
      expect(b64Parse(b64Stringify(n))).toBe(n);
    }
  });
});

describe('b64 is', () => {
  test('valid characters', () => {
    for (let i = 0; i < 256; i++) {
      const char = String.fromCharCode(i);
      if (
        (i >= 48 && i <= 57) || // 0-9
        (i >= 65 && i <= 90) || // A-Z
        (i >= 97 && i <= 122) || // a-z
        char === '-' ||
        char === '_'
      ) {
        expect(isB64(i)).toBe(true);
      } else {
        expect(isB64(i)).toBe(false);
      }
    }
  });
});

describe('b64 sizeof', () => {
  test('size of b64 encoding', () => {
    expect(() => b64Sizeof(-1)).toThrow();
    expect(b64Sizeof(0)).toBe(0);
    expect(b64Sizeof(1)).toBe(1);
    expect(b64Sizeof(63)).toBe(1);
    expect(b64Sizeof(64)).toBe(2);
    expect(b64Sizeof(4095)).toBe(2);
    expect(b64Sizeof(4096)).toBe(3);
    expect(b64Sizeof(262143)).toBe(3);
    expect(b64Sizeof(262144)).toBe(4);
    expect(b64Sizeof(2 ** 53 - 1)).toBe(9);
    expect(() => b64Sizeof(2 ** 53)).toThrow();
  });
});

describe('b64 read', () => {
  test('decoding b64 digits in correct order', () => {
    const data = new Uint8Array([45, 95, 48, 49]); // '-_01'
    expect(b64Read(data, 0, 1)).toBe(62);
    expect(b64Read(data, 1, 2)).toBe(63);
    expect(b64Read(data, 2, 3)).toBe(0);
    expect(b64Read(data, 3, 4)).toBe(1);
    expect(b64Read(data, 2, 4)).toBe(0 * 64 + 1);
    expect(b64Read(data, 0, 2)).toBe(62 * 64 + 63);
    expect(b64Read(data, 0, 3)).toBe(62 * 64 * 64 + 63 * 64 + 0);
    expect(b64Read(data, 0, 4)).toBe(62 * 64 * 64 * 64 + 63 * 64 * 64 + 0 * 64 + 1);
    expect(b64Read(data, 1, 4)).toBe(63 * 64 * 64 + 0 * 64 + 1);
  });

  test('fails on invalid characters', () => {
    const data = new Uint8Array([45, 95, 48, 49, 64]); // '-_01@'
    expect(() => b64Read(data, 0, 5)).toThrow();
    expect(() => b64Read(data, 4, 5)).toThrow();
    expect(() => b64Read(data, 0, 4)).not.toThrow();
  });
});

describe('b64 write', () => {
  test('writing b64 digits to data', () => {
    const data = new Uint8Array(10);
    b64Write(data, 0, 10, 0);
    expect(data.slice(0, 10)).toEqual(new Uint8Array([48, 48, 48, 48, 48, 48, 48, 48, 48, 48]));
    b64Write(data, 0, 2, 62 * 64 + 63); // '-_'
    expect(data.slice(0, 2)).toEqual(new Uint8Array([45, 95]));
    b64Write(data, 2, 5, 62 * 64 * 64 + 63 * 64 + 1); // '-_01'
    expect(data.slice(2, 5)).toEqual(new Uint8Array([45, 95, 49]));
    b64Write(data, 0, 10, Number.MAX_SAFE_INTEGER); // '_v________'
    expect(data.slice(0, 10)).toEqual(new Uint8Array([48, 118, 95, 95, 95, 95, 95, 95, 95, 95]));
    b64Write(data, 0, 10, 2 ** 53); // '0w00000000'
    expect(data.slice(0, 10)).toEqual(new Uint8Array([48, 119, 48, 48, 48, 48, 48, 48, 48, 48]));
  });
  test('fails on write overflow', () => {
    const data = new Uint8Array(5);
    expect(() => b64Write(data, 0, 5, 2 ** 40)).toThrow();
  });
});

describe('b64 sizeof+write+read', () => {
  test('random fuzzing', () => {
    for (let i = 0; i < 100000; i++) {
      const n = Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER + 2));
      const size = b64Sizeof(n);
      const data = new Uint8Array(size);
      b64Write(data, 0, size, n);
      expect(b64Read(data, 0, size)).toBe(n);
    }
  });
});

describe('zigzag toZigZag', () => {
  test('encodes small values', () => {
    expect(toZigZag(0)).toBe(0);
    expect(toZigZag(-1)).toBe(1);
    expect(toZigZag(1)).toBe(2);
    expect(toZigZag(-2)).toBe(3);
    expect(toZigZag(2)).toBe(4);
  });
  test('encodes 31-bit boundary values', () => {
    expect(toZigZag(0x3fffffff)).toBe(0x7ffffffe);
    expect(toZigZag(-0x40000000)).toBe(0x7fffffff);
    expect(toZigZag(0x40000000)).toBe(0x80000000);
    expect(toZigZag(-0x40000001)).toBe(0x80000001);
  });
  test('encodes at bitwise/arithmetic boundary (int32)', () => {
    expect(toZigZag(0x7fffffff)).toBe(0xfffffffe);
    expect(toZigZag(-0x80000000)).toBe(0xffffffff);
    expect(toZigZag(0x80000000)).toBe(0x100000000);
    expect(toZigZag(-0x80000001)).toBe(0x100000001);
  });
});

describe('zigzag fromZigZag', () => {
  test('decodes small values', () => {
    expect(fromZigZag(0)).toBe(0);
    expect(fromZigZag(1)).toBe(-1);
    expect(fromZigZag(2)).toBe(1);
    expect(fromZigZag(3)).toBe(-2);
    expect(fromZigZag(4)).toBe(2);
  });
  test('decodes 31-bit boundary values', () => {
    expect(fromZigZag(0x7ffffffe)).toBe(0x3fffffff);
    expect(fromZigZag(0x7fffffff)).toBe(-0x40000000);
    expect(fromZigZag(0x80000000)).toBe(0x40000000);
    expect(fromZigZag(0x80000001)).toBe(-0x40000001);
  });
  test('decodes at bitwise/arithmetic boundary (uint32)', () => {
    expect(fromZigZag(0xfffffffe)).toBe(0x7fffffff);
    expect(fromZigZag(0xffffffff)).toBe(-0x80000000);
    expect(fromZigZag(0x100000000)).toBe(0x80000000);
    expect(fromZigZag(0x100000001)).toBe(-0x80000001);
  });
});

describe('zigzag roundtrip', () => {
  test('small values', () => {
    for (let i = -1000; i <= 1000; i++) {
      expect(fromZigZag(toZigZag(i))).toBe(i);
    }
  });
  test('random fuzzing', () => {
    // Zigzag doubles the magnitude, so limit to half MAX_SAFE_INTEGER
    const half = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    for (let i = 0; i < 100000; i++) {
      const n = Math.floor(Math.random() * half) * (Math.random() < 0.5 ? 1 : -1);
      expect(fromZigZag(toZigZag(n))).toBe(n);
    }
  });
});

