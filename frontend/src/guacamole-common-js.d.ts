declare module "guacamole-common-js" {
  export class WebSocketTunnel {
    constructor(tunnelURL: string);
    onstatechange?: (state: number) => void;
    onerror?: (status: { code: number; message?: string }) => void;
    connect(data?: string): void;
    disconnect(): void;
  }

  export class Display {
    getElement(): HTMLElement;
    getWidth(): number;
    getHeight(): number;
    scale(scaleFactor: number): void;
    onresize?: (width: number, height: number) => void;
  }

  export class Client {
    constructor(tunnel: WebSocketTunnel);
    getDisplay(): Display;
    connect(connectString?: string): void;
    disconnect(): void;
    sendSize(width: number, height: number): void;
    sendKeyEvent(pressed: number, keysym: number): void;
    sendMouseState(mouseState: MouseState): void;
    onstatechange?: (state: number) => void;
    onerror?: (status: { code: number; message?: string }) => void;
  }

  export interface MouseState {
    x: number;
    y: number;
    left: boolean;
    middle: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
  }

  export class Mouse {
    constructor(element: HTMLElement);
    onmousedown?: (state: MouseState) => void;
    onmouseup?: (state: MouseState) => void;
    onmousemove?: (state: MouseState) => void;
  }

  export class Keyboard {
    constructor(element?: HTMLElement | Document);
    onkeydown?: (keysym: number) => boolean | void;
    onkeyup?: (keysym: number) => void;
    reset(): void;
  }

  const Guacamole: {
    WebSocketTunnel: typeof WebSocketTunnel;
    Client: typeof Client;
    Mouse: typeof Mouse;
    Keyboard: typeof Keyboard;
  };

  export default Guacamole;
}

