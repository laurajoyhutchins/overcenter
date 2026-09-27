type Callback = () => void;

function invoke(callback: Callback): void {
  callback();
}

invoke(() => {});
