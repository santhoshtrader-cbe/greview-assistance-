import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "review-assistant-settings";
const FEEDBACK_KEY = "review-assistant-feedback";
const API_HEADERS = {
  "Content-Type": "application/json"
};

const emptyForm = {
  businessName: "",
  googleReviewUrl: "",
  rating: 0,
  reviewText: ""
};

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidGoogleReviewUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const allowedHosts = ["google.com", "www.google.com", "g.page", "maps.app.goo.gl"];

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}

function buildShareLink(businessName, googleReviewUrl) {
  if (typeof window === "undefined") {
    return "";
  }

  const shareUrl = new URL(window.location.pathname, window.location.origin);
  shareUrl.searchParams.set("biz", businessName);
  shareUrl.searchParams.set("reviewUrl", googleReviewUrl);
  return shareUrl.toString();
}

function StarRating({ rating, onChange }) {
  return (
    <div className="stars" aria-label="Choose a rating from 1 to 5 stars">
      {[1, 2, 3, 4, 5].map((star) => {
        const active = star <= rating;

        return (
          <button
            key={star}
            type="button"
            className={`star ${active ? "active" : ""}`}
            onClick={() => onChange(star)}
            aria-label={`${star} star${star > 1 ? "s" : ""}`}
            aria-pressed={active}
          >
            {"\u2605"}
          </button>
        );
      })}
    </div>
  );
}

export default function App() {
  const [form, setForm] = useState(emptyForm);
  const [screen, setScreen] = useState("loading");
  const [setupError, setSetupError] = useState("");
  const [apiError, setApiError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isCustomerMode, setIsCustomerMode] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const businessName = params.get("biz")?.trim() || "";
    const googleReviewUrl = params.get("reviewUrl")?.trim() || "";

    if (businessName && isValidGoogleReviewUrl(googleReviewUrl)) {
      setForm((current) => ({
        ...current,
        businessName,
        googleReviewUrl
      }));
      setIsCustomerMode(true);
      setScreen("customer");
      return;
    }

    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      setScreen("owner-setup");
      return;
    }

    try {
      const parsed = JSON.parse(stored);
      const storedBusinessName = parsed.businessName?.trim() || "";
      const storedReviewUrl = parsed.googleReviewUrl?.trim() || "";

      if (storedBusinessName && isValidGoogleReviewUrl(storedReviewUrl)) {
        setForm((current) => ({
          ...current,
          businessName: storedBusinessName,
          googleReviewUrl: storedReviewUrl
        }));
        setScreen("owner-share");
        return;
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }

    setScreen("owner-setup");
  }, []);

  const shareLink = useMemo(() => {
    if (!form.businessName || !form.googleReviewUrl) {
      return "";
    }

    return buildShareLink(form.businessName, form.googleReviewUrl);
  }, [form.businessName, form.googleReviewUrl]);

  const ratingLabel = useMemo(() => {
    if (!form.rating) {
      return "Tap a star and type your review below";
    }

    return `${form.rating} out of 5 stars`;
  }, [form.rating]);

  const reviewPrompt = useMemo(() => {
    if (form.rating >= 4) {
      return "Write your review here";
    }

    if (form.rating > 0 && form.rating <= 3) {
      return "Tell us what happened";
    }

    return "After choosing stars, write your review or feedback here";
  }, [form.rating]);

  function updateField(field, value) {
    setApiError("");
    setStatusMessage("");
    setForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  function handleRatingChange(value) {
    setApiError("");
    setStatusMessage("");
    setForm((current) => ({
      ...current,
      rating: value
    }));
  }

  function handleSetupSubmit(event) {
    event.preventDefault();
    setSetupError("");
    setStatusMessage("");

    const businessName = form.businessName.trim();
    const googleReviewUrl = form.googleReviewUrl.trim();

    if (!businessName) {
      setSetupError("Please enter the business name.");
      return;
    }

    if (!isValidHttpUrl(googleReviewUrl) || !isValidGoogleReviewUrl(googleReviewUrl)) {
      setSetupError("Please enter a valid Google review link from Google.");
      return;
    }

    const nextState = {
      businessName,
      googleReviewUrl
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    setForm((current) => ({
      ...current,
      ...nextState
    }));
    setScreen("owner-share");
  }

  async function callReviewAssist() {
    if (!form.rating) {
      setApiError("Please choose a rating first.");
      return;
    }

    setIsLoading(true);
    setApiError("");
    setStatusMessage("");

    try {
      const response = await fetch("/api/review-assist", {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({
          businessName: form.businessName,
          rating: form.rating,
          draft: form.reviewText
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Unable to generate review help.");
      }

      setForm((current) => ({
        ...current,
        reviewText: data.text
      }));
      setStatusMessage("Suggestion added. You can edit it before copying or posting.");
    } catch (error) {
      setApiError(error.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleImproveFeedback() {
    if (!form.reviewText.trim()) {
      setApiError("Please type your feedback first.");
      return;
    }

    setIsLoading(true);
    setApiError("");
    setStatusMessage("");

    try {
      const response = await fetch("/api/improve-feedback", {
        method: "POST",
        headers: API_HEADERS,
        body: JSON.stringify({
          feedback: form.reviewText,
          businessName: form.businessName,
          rating: form.rating
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Unable to improve the feedback.");
      }

      setForm((current) => ({
        ...current,
        reviewText: data.text
      }));
      setStatusMessage("Feedback wording updated. Please review it before sending.");
    } catch (error) {
      setApiError(error.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCopyText() {
    if (!form.reviewText.trim()) {
      setApiError("There is no text to copy yet.");
      return;
    }

    try {
      await navigator.clipboard.writeText(form.reviewText);
      setStatusMessage("Text copied.");
    } catch {
      setApiError("Copy failed. Please copy the text manually.");
    }
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.top = "-9999px";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        return ok;
      } catch {
        return false;
      }
    }
  }

  async function handleCopyAndRedirect() {
    setApiError("");
    setStatusMessage("");

    const text = form.reviewText.trim();
    if (!text) {
      setApiError("Please type your review text first.");
      return;
    }

    const copied = await copyToClipboard(text);
    if (!copied) {
      setApiError("Copy failed. Please copy the text manually.");
      return;
    }

    setStatusMessage("Copied. Opening Google review...");
    setTimeout(() => {
      window.location.href = form.googleReviewUrl;
    }, 350);
  }

  async function handleAiSuggestion() {
    setApiError("");
    setStatusMessage("");

    if (!form.rating) {
      setApiError("Please choose a rating first.");
      return;
    }

    if (form.rating >= 4) {
      await callReviewAssist();
      return;
    }

    if (form.rating >= 1 && form.rating <= 3) {
      await handleImproveFeedback();
    }
  }

  async function handleCopyShareLink() {
    if (!shareLink) {
      return;
    }

    try {
      await navigator.clipboard.writeText(shareLink);
      setStatusMessage("Share link copied.");
    } catch {
      setSetupError("Unable to copy the link. Please copy it manually.");
    }
  }

  function handleGoToGoogleReview() {
    window.location.href = form.googleReviewUrl;
  }

  function handleOpenCustomerView() {
    window.open(shareLink, "_blank", "noopener,noreferrer");
  }

  function handleSubmitFeedback() {
    if (!form.reviewText.trim()) {
      setApiError("Please type feedback before submitting.");
      return;
    }

    const history = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || "[]");
    history.push({
      businessName: form.businessName,
      rating: form.rating,
      feedback: form.reviewText.trim(),
      submittedAt: new Date().toISOString()
    });
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(history));
    setStatusMessage("Feedback saved. Thank you.");
  }

  function openOwnerSetup() {
    setIsCustomerMode(false);
    setSetupError("");
    setStatusMessage("");
    setScreen("owner-setup");
  }

  if (screen === "loading") {
    return null;
  }

  const isCustomerScreen = screen === "customer";

  return (
    <main className={`app-shell ${isCustomerScreen ? "app-shell--customer" : ""}`}>
      <section className={`card ${isCustomerScreen ? "card--customer" : ""}`}>
        <div className="eyebrow">Review Assistant</div>

        {screen === "owner-setup" ? (
          <div className="stack">
            <h1>Set your business once and share the customer link.</h1>
            <p className="subtle">
              This screen is only for you as the business owner. Your customers will
              open the shared link and only see the rating and review form.
            </p>

            <form className="stack" onSubmit={handleSetupSubmit}>
              <label className="field">
                <span>Business Name</span>
                <input
                  type="text"
                  value={form.businessName}
                  onChange={(event) => updateField("businessName", event.target.value)}
                  placeholder="Example: Bluebird Cafe"
                />
              </label>

              <label className="field">
                <span>Google Review Link</span>
                <input
                  type="url"
                  value={form.googleReviewUrl}
                  onChange={(event) => updateField("googleReviewUrl", event.target.value)}
                  placeholder="https://g.page/r/..."
                />
              </label>

              {setupError ? <p className="error">{setupError}</p> : null}

              <button type="submit" className="primary-button">
                Save and Create Customer Link
              </button>
            </form>
          </div>
        ) : null}

        {screen === "owner-share" ? (
          <div className="stack">
            <h1>Your customer review link is ready.</h1>
            <p className="subtle">
              Share this link with your customers. They will only see the rating and
              review page for {form.businessName}.
            </p>

            <div className="panel stack">
              <label className="field">
                <span>Customer Share Link</span>
                <textarea rows="4" value={shareLink} readOnly />
              </label>

              <div className="button-group">
                <button type="button" className="primary-button" onClick={handleCopyShareLink}>
                  Copy Share Link
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleOpenCustomerView}
                >
                  Open Customer View
                </button>
              </div>
            </div>

            <button type="button" className="link-button" onClick={openOwnerSetup}>
              Edit business details
            </button>
            {statusMessage ? <p className="success">{statusMessage}</p> : null}
            {setupError ? <p className="error">{setupError}</p> : null}
          </div>
        ) : null}

        {screen === "customer" ? (
          <div className="customer-screen">
            {!isCustomerMode ? (
              <button type="button" className="link-button" onClick={() => setScreen("owner-share")}>
                Back to owner view
              </button>
            ) : null}

            <h1>How was your experience with {form.businessName}?</h1>
            <p className="subtle">Choose stars, type your review, then copy and post on Google.</p>

            <div className="rating-block">
              <StarRating rating={form.rating} onChange={handleRatingChange} />
              <p className="rating-label">{ratingLabel}</p>
            </div>

            <label className="field customer-field">
              <span>Your review</span>
              <textarea
                rows="4"
                className="customer-textarea"
                value={form.reviewText}
                onChange={(event) => updateField("reviewText", event.target.value)}
                placeholder={reviewPrompt}
              />
            </label>

            <div className="button-group customer-actions">
              <button
                type="button"
                className="primary-button"
                onClick={handleAiSuggestion}
                disabled={isLoading}
              >
                {isLoading ? "Working..." : "AI Suggestion"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={handleCopyAndRedirect}
              >
                Copy Text & Rate Us
              </button>
            </div>

            {statusMessage ? <p className="success">{statusMessage}</p> : null}
            {apiError ? <p className="error">{apiError}</p> : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
