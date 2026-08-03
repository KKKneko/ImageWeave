import { createElement } from "../core/dom.js";

let dialogSequence = 0;

function requireText(value, label, maximum = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new TypeError(`${label}必须是非空文本`);
  }
  return value.trim();
}

function focusableElements(dialog) {
  return [...dialog.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

export function createDialogController({ documentObject = globalThis.document } = {}) {
  if (!documentObject || typeof documentObject.createElement !== "function") {
    throw new TypeError("对话框需要可用的 document");
  }
  let active = null;

  const open = ({
    title,
    message,
    confirmLabel,
    cancelLabel = "取消",
    dangerous = false,
    confirmationText = "",
  } = {}) => {
    if (active) throw new Error("同一控制器一次只能打开一个对话框");
    const safeTitle = requireText(title, "对话框标题", 160);
    const safeMessage = requireText(message, "对话框内容", 1000);
    const safeCancelLabel = requireText(cancelLabel, "取消按钮文案", 80);
    if (dangerous && (!confirmLabel || !confirmationText)) {
      throw new TypeError("危险操作必须显式提供确认按钮和确认说明");
    }
    const safeConfirmLabel = requireText(confirmLabel || "确认", "确认按钮文案", 80);
    const safeConfirmationText = confirmationText
      ? requireText(confirmationText, "确认说明", 500)
      : "";

    dialogSequence += 1;
    const titleId = `imageweave-dialog-title-${dialogSequence}`;
    const descriptionId = `imageweave-dialog-description-${dialogSequence}`;
    const dialog = createElement("dialog", {
      className: `imageweave-dialog${dangerous ? " imageweave-dialog--dangerous" : ""}`,
      attributes: {
        "aria-labelledby": titleId,
        "aria-describedby": descriptionId,
      },
    });
    const cancelButton = createElement("button", {
      text: safeCancelLabel,
      attributes: { type: "button" },
    });
    const confirmButton = createElement("button", {
      className: dangerous ? "dialog-confirm dialog-confirm--dangerous" : "dialog-confirm",
      text: safeConfirmLabel,
      attributes: { type: "button" },
    });
    dialog.append(
      createElement("section", { className: "imageweave-dialog__panel" }, [
        createElement("h2", { text: safeTitle, attributes: { id: titleId } }),
        createElement("p", { text: safeMessage, attributes: { id: descriptionId } }),
        ...(safeConfirmationText
          ? [createElement("p", {
              className: "dialog-confirmation-copy",
              text: safeConfirmationText,
            })]
          : []),
        createElement("div", { className: "imageweave-dialog__actions" }, [
          cancelButton,
          confirmButton,
        ]),
      ]),
    );

    const previousFocus = documentObject.activeElement;
    let settled = false;
    let resolveResult;
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });

    const cleanup = () => {
      cancelButton.removeEventListener("click", onCancelClick);
      confirmButton.removeEventListener("click", onConfirmClick);
      dialog.removeEventListener("cancel", onNativeCancel);
      dialog.removeEventListener("keydown", onKeyDown);
      dialog.removeEventListener("close", onNativeClose);
    };

    const finish = (choice) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      dialog.remove();
      active = null;
      if (previousFocus && typeof previousFocus.focus === "function" && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
      resolveResult(choice);
    };

    const onCancelClick = () => finish("cancel");
    const onConfirmClick = () => finish("confirm");
    const onNativeCancel = (event) => {
      event.preventDefault();
      finish("cancel");
    };
    const onNativeClose = () => finish("cancel");
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish("cancel");
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && documentObject.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && documentObject.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    cancelButton.addEventListener("click", onCancelClick);
    confirmButton.addEventListener("click", onConfirmClick);
    dialog.addEventListener("cancel", onNativeCancel);
    dialog.addEventListener("keydown", onKeyDown);
    dialog.addEventListener("close", onNativeClose);
    documentObject.body.append(dialog);
    active = { finish };
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    queueMicrotask(() => {
      if (!settled) cancelButton.focus({ preventScroll: true });
    });
    return result;
  };

  return Object.freeze({
    open,
    destroy() {
      active?.finish("cancel");
    },
  });
}
