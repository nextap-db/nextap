function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function rowToClient(row, origin) {
  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    job_title: row.job_title || "",
    company: row.company || "",
    about: row.about || "",

    phone: row.phone || "",
    email: row.email || "",
    messenger: row.messenger || "",
    whatsapp: row.whatsapp || "",
    viber: row.viber || "",

    instagram: row.instagram || "",
    facebook: row.facebook || "",
    linkedin: row.linkedin || "",
    tiktok: row.tiktok || "",
    youtube: row.youtube || "",
    x: row.x || "",
    telegram: row.telegram || "",
    threads: row.threads || "",
    github: row.github || "",
    behance: row.behance || "",
    dribbble: row.dribbble || "",
    website: row.website || "",

    accent_color: row.accent_color || "#2162c6",

    // Card Type
    card_type: row.card_type || "basic",

    active: Boolean(row.active),
    view_count: Number(row.view_count || 0),
    last_viewed_at: row.last_viewed_at || "",

    photo_url: row.photo_key || "",
    photo: row.photo_key || "",

    // Featured
    featured_enabled: Boolean(row.featured_enabled),
    featured_title: row.featured_title || "",
    featured_description: row.featured_description || "",
    featured_image: row.featured_image || "",
    featured_button_text: row.featured_button_text || "",
    featured_button_link: row.featured_button_link || "",

    // Quick Info
    location: row.location || "",
    business_hours: row.business_hours || "",
    services: row.services || "",
    portfolio: row.portfolio || "",
    booking: row.booking || "",
    reviews: row.reviews || "",
    payments: row.payments || "",

    // New Quick Info
    education: row.education || "",
    skills: row.skills || "",
    resume: row.resume || "",
    achievements: row.achievements || "",
    certifications: row.certifications || "",
    pricing: row.pricing || "",
    products: row.products || "",
    promotions: row.promotions || "",
    team: row.team || "",
    multiple_locations: row.multiple_locations || "",
    business_inquiry: row.business_inquiry || "",

    // Quick Info Order
    quick_info_order:
      row.quick_info_order ||
      '["location","business_hours","services","portfolio","booking","reviews","payments","education","skills","resume","achievements","certifications","pricing","products","promotions","team","multiple_locations","business_inquiry"]',

    quick_info_enabled: row.quick_info_enabled !== 0,

    show_location: row.show_location !== 0,
    show_business_hours: row.show_business_hours !== 0,
    show_services: row.show_services !== 0,
    show_portfolio: row.show_portfolio !== 0,
    show_booking: row.show_booking !== 0,
    show_reviews: row.show_reviews !== 0,
    show_payments: row.show_payments !== 0,

    // New Quick Info visibility
    show_education: row.show_education !== 0,
    show_skills: row.show_skills !== 0,
    show_resume: row.show_resume !== 0,
    show_achievements: row.show_achievements !== 0,
    show_certifications: row.show_certifications !== 0,
    show_pricing: row.show_pricing !== 0,
    show_products: row.show_products !== 0,
    show_promotions: row.show_promotions !== 0,
    show_team: row.show_team !== 0,
    show_multiple_locations: row.show_multiple_locations !== 0,
    show_business_inquiry: row.show_business_inquiry !== 0
  };
}

async function getClientByKey(env, key, origin) {
  const row = await env.DB.prepare(
    "SELECT * FROM clients WHERE (id = ? OR slug = ?) AND active = 1 LIMIT 1"
  )
    .bind(key, key)
    .first();

  return rowToClient(row, origin);
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    new RegExp(
      "(^|;\\s*)" +
        name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "=([^;]*)"
    )
  );

  return match ? decodeURIComponent(match[2]) : null;
}

function base64UrlEncode(bytes) {
  let binary = "";

  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const binary = atob(padded);

  return Uint8Array.from(
    binary,
    c => c.charCodeAt(0)
  );
}

async function hmacSign(text, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text)
  );

  return base64UrlEncode(
    new Uint8Array(signature)
  );
}

async function createAdminSession(env) {
  const expires =
    Date.now() +
    7 * 24 * 60 * 60 * 1000;

  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        role: "admin",
        exp: expires
      })
    )
  );

  const signature = await hmacSign(
    payload,
    env.ADMIN_PASSWORD
  );

  return payload + "." + signature;
}

async function verifyAdminSession(request, env) {
  const token = getCookie(
    request,
    "nextap_admin"
  );

  if (!token || !env.ADMIN_PASSWORD) {
    return false;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return false;
  }

  const [payload, signature] = parts;

  try {
    const expected = await hmacSign(
      payload,
      env.ADMIN_PASSWORD
    );

    if (signature.length !== expected.length) {
      return false;
    }

    let diff = 0;

    for (
      let i = 0;
      i < signature.length;
      i++
    ) {
      diff |=
        signature.charCodeAt(i) ^
        expected.charCodeAt(i);
    }

    if (diff !== 0) {
      return false;
    }

    const data = JSON.parse(
      new TextDecoder().decode(
        base64UrlDecode(payload)
      )
    );

    return (
      data.role === "admin" &&
      data.exp > Date.now()
    );
  } catch {
    return false;
  }
}

async function handleAuth(request, env, url) {
  if (
    url.pathname === "/api/auth/me" &&
    request.method === "GET"
  ) {
    return json({
      authenticated:
        await verifyAdminSession(
          request,
          env
        )
    });
  }

  if (
    url.pathname === "/api/auth/login" &&
    request.method === "POST"
  ) {
    let body;

    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: "Invalid request"
        }),
        {
          status: 400,
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }

    if (!env.ADMIN_PASSWORD) {
      return new Response(
        JSON.stringify({
          error:
            "ADMIN_PASSWORD is not configured"
        }),
        {
          status: 500,
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }

    if (
      body.password !==
      env.ADMIN_PASSWORD
    ) {
      return new Response(
        JSON.stringify({
          error: "Invalid password"
        }),
        {
          status: 401,
          headers: {
            "Content-Type":
              "application/json"
          }
        }
      );
    }

    const token =
      await createAdminSession(env);

    return new Response(
      JSON.stringify({
        ok: true
      }),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json",
          "Set-Cookie":
            `nextap_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`
        }
      }
    );
  }

  if (
    url.pathname === "/api/auth/logout" &&
    request.method === "POST"
  ) {
    return new Response(
      JSON.stringify({
        ok: true
      }),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json",
          "Set-Cookie":
            "nextap_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
        }
      }
    );
  }

  return null;
}

async function handleApi(
  request,
  env,
  url
) {
  const p = url.pathname;

  // PROTECT ADMIN API
  const isPublicApi =
    p === "/api/auth/login" ||
    p === "/api/auth/logout" ||
    p === "/api/auth/me" ||
    (
      p.startsWith("/api/clients/") &&
      request.method === "GET"
    ) ||
    (
      p.startsWith("/api/clients/") &&
      request.method === "POST" &&
      p.endsWith("/view")
    );

  if (
    p.startsWith("/api/") &&
    !isPublicApi
  ) {
    const authenticated =
      await verifyAdminSession(
        request,
        env
      );

    if (!authenticated) {
      return json(
        {
          error: "Unauthorized"
        },
        401
      );
    }
  }

  // GET ALL CLIENTS
  if (
    p === "/api/clients" &&
    request.method === "GET"
  ) {
    const { results } =
      await env.DB
        .prepare(
          "SELECT * FROM clients ORDER BY created_at DESC"
        )
        .all();

    return json(
      results.map(
        r =>
          rowToClient(
            r,
            url.origin
          )
      )
    );
  }

  // GET ONE CLIENT
  if (
    p.startsWith("/api/clients/") &&
    request.method === "GET"
  ) {
    const key =
      decodeURIComponent(
        p.split("/").pop()
      );

    const client =
      await getClientByKey(
        env,
        key,
        url.origin
      );

    return client
      ? json(client)
      : json(
          {
            error:
              "Client profile not found"
          },
          404
        );
  }

  // CREATE / UPDATE CLIENT
  if (
    p === "/api/clients" &&
    (
      request.method === "POST" ||
      request.method === "PUT"
    )
  ) {
    const d =
      await request.json();

    const name =
      String(
        d.name || ""
      ).trim();

    if (!name) {
      return json(
        {
          error:
            "Name is required."
        },
        400
      );
    }

    const id =
      String(
        d.id ||
        slugify(name)
      );

    const slug =
      slugify(
        d.slug ||
        name
      );

    if (!id || !slug) {
      return json(
        {
          error:
            "A valid name/slug is required."
        },
        400
      );
    }

    const existing =
      await env.DB
        .prepare(
          "SELECT photo_key, view_count, created_at, last_viewed_at FROM clients WHERE id = ? LIMIT 1"
        )
        .bind(id)
        .first();

    const photoKey =
      String(
        d.photo_key ||
        existing?.photo_key ||
        ""
      );

    const now =
      new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO clients
      (
        id,
        slug,
        name,
        job_title,
        company,
        about,
        phone,
        email,
        instagram,
        facebook,
        linkedin,
        tiktok,
        youtube,
        x,
        telegram,
        threads,
        github,
        behance,
        dribbble,
        messenger,
        whatsapp,
        viber,
        website,
        accent_color,

        card_type,

        photo_key,
        active,
        view_count,
        last_viewed_at,
        created_at,
        updated_at,

        featured_enabled,
        featured_title,
        featured_description,
        featured_image,
        featured_button_text,
        featured_button_link,

        location,
        business_hours,
        services,
        portfolio,
        booking,
        reviews,
        payments,

        education,
        skills,
        resume,
        achievements,
        certifications,
        pricing,
        products,
        promotions,
        team,
        multiple_locations,
        business_inquiry,

        quick_info_enabled,

        show_location,
        show_business_hours,
        show_services,
        show_portfolio,
        show_booking,
        show_reviews,
        show_payments,

        show_education,
        show_skills,
        show_resume,
        show_achievements,
        show_certifications,
        show_pricing,
        show_products,
        show_promotions,
        show_team,
        show_multiple_locations,
        show_business_inquiry
      )
    VALUES (
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?,?,?,?,?,?,?,
  ?,?,?,?
)
      ON CONFLICT(id) DO UPDATE SET

        slug=excluded.slug,
        name=excluded.name,
        job_title=excluded.job_title,
        company=excluded.company,
        about=excluded.about,

        phone=excluded.phone,
        email=excluded.email,
        instagram=excluded.instagram,
        facebook=excluded.facebook,
        linkedin=excluded.linkedin,
        tiktok=excluded.tiktok,
        youtube=excluded.youtube,
        x=excluded.x,
        telegram=excluded.telegram,
        threads=excluded.threads,
        github=excluded.github,
        behance=excluded.behance,
        dribbble=excluded.dribbble,
        messenger=excluded.messenger,
        whatsapp=excluded.whatsapp,
        viber=excluded.viber,
        website=excluded.website,

        accent_color=excluded.accent_color,
        card_type=excluded.card_type,
        photo_key=excluded.photo_key,
        active=excluded.active,

        featured_enabled=excluded.featured_enabled,
        featured_title=excluded.featured_title,
        featured_description=excluded.featured_description,
        featured_image=excluded.featured_image,
        featured_button_text=excluded.featured_button_text,
        featured_button_link=excluded.featured_button_link,

        location=excluded.location,
        business_hours=excluded.business_hours,
        services=excluded.services,
        portfolio=excluded.portfolio,
        booking=excluded.booking,
        reviews=excluded.reviews,
        payments=excluded.payments,

        education=excluded.education,
        skills=excluded.skills,
        resume=excluded.resume,
        achievements=excluded.achievements,
        certifications=excluded.certifications,
        pricing=excluded.pricing,
        products=excluded.products,
        promotions=excluded.promotions,
        team=excluded.team,
        multiple_locations=excluded.multiple_locations,
        business_inquiry=excluded.business_inquiry,

        quick_info_enabled=excluded.quick_info_enabled,

        show_location=excluded.show_location,
        show_business_hours=excluded.show_business_hours,
        show_services=excluded.show_services,
        show_portfolio=excluded.show_portfolio,
        show_booking=excluded.show_booking,
        show_reviews=excluded.show_reviews,
        show_payments=excluded.show_payments,

        show_education=excluded.show_education,
        show_skills=excluded.show_skills,
        show_resume=excluded.show_resume,
        show_achievements=excluded.show_achievements,
        show_certifications=excluded.show_certifications,
        show_pricing=excluded.show_pricing,
        show_products=excluded.show_products,
        show_promotions=excluded.show_promotions,
        show_team=excluded.show_team,
        show_multiple_locations=excluded.show_multiple_locations,
        show_business_inquiry=excluded.show_business_inquiry,

        updated_at=excluded.updated_at
    `).bind(

      id,
      slug,
      name,

      String(d.job_title || ""),
      String(d.company || ""),
      String(d.about || ""),

      String(d.phone || ""),
      String(d.email || ""),

      String(d.instagram || ""),
      String(d.facebook || ""),
      String(d.linkedin || ""),
      String(d.tiktok || ""),
      String(d.youtube || ""),
      String(d.x || ""),
      String(d.telegram || ""),
      String(d.threads || ""),
      String(d.github || ""),
      String(d.behance || ""),
      String(d.dribbble || ""),

      String(d.messenger || ""),
      String(d.whatsapp || ""),
      String(d.viber || ""),
      String(d.website || ""),

      String(
        d.accent_color ||
        "#2162c6"
      ),

      // Card Type
      ["basic", "premium", "gold"].includes(
        String(d.card_type)
      )
        ? String(d.card_type)
        : "basic",

      photoKey,

      d.active === false
        ? 0
        : 1,

      Number(
        existing?.view_count ||
        d.view_count ||
        0
      ),

      String(
        existing?.last_viewed_at ||
        ""
      ),

      String(
        existing?.created_at ||
        now
      ),

      now,

      // Featured
      d.featured_enabled
        ? 1
        : 0,

      String(
        d.featured_title ||
        ""
      ),

      String(
        d.featured_description ||
        ""
      ),

      String(
        d.featured_image ||
        ""
      ),

      String(
        d.featured_button_text ||
        ""
      ),

      String(
        d.featured_button_link ||
        ""
      ),

      // Quick Info
      String(
        d.location ||
        ""
      ),

      String(
        d.business_hours ||
        ""
      ),

      String(
        d.services ||
        ""
      ),

      String(
        d.portfolio ||
        ""
      ),

      String(
        d.booking ||
        ""
      ),

      String(
        d.reviews ||
        ""
      ),

      String(
        d.payments ||
        ""
      ),

      // New Quick Info
      String(
        d.education ||
        ""
      ),

      String(
        d.skills ||
        ""
      ),

      String(
        d.resume ||
        ""
      ),

      String(
        d.achievements ||
        ""
      ),

      String(
        d.certifications ||
        ""
      ),

      String(
        d.pricing ||
        ""
      ),

      String(
        d.products ||
        ""
      ),

      String(
        d.promotions ||
        ""
      ),

      String(
        d.team ||
        ""
      ),

      String(
        d.multiple_locations ||
        ""
      ),

      String(
        d.business_inquiry ||
        ""
      ),

      d.quick_info_enabled === false
        ? 0
        : 1,

      d.show_location === false
        ? 0
        : 1,

      d.show_business_hours === false
        ? 0
        : 1,

      d.show_services === false
        ? 0
        : 1,

      d.show_portfolio === false
        ? 0
        : 1,

      d.show_booking === false
        ? 0
        : 1,

      d.show_reviews === false
        ? 0
        : 1,

      d.show_payments === false
        ? 0
        : 1,

      // New Quick Info visibility
      d.show_education === false
        ? 0
        : 1,

      d.show_skills === false
        ? 0
        : 1,

      d.show_resume === false
        ? 0
        : 1,

      d.show_achievements === false
        ? 0
        : 1,

      d.show_certifications === false
        ? 0
        : 1,

      d.show_pricing === false
        ? 0
        : 1,

      d.show_products === false
        ? 0
        : 1,

      d.show_promotions === false
        ? 0
        : 1,

      d.show_team === false
        ? 0
        : 1,

      d.show_multiple_locations === false
        ? 0
        : 1,

      d.show_business_inquiry === false
        ? 0
        : 1

    ).run();

    const quickInfoOrder =
  Array.isArray(d.quick_info_order)
    ? d.quick_info_order
    : [];

await env.DB
  .prepare(
    "UPDATE clients SET quick_info_order = ?, updated_at = ? WHERE id = ?"
  )
  .bind(
    JSON.stringify(quickInfoOrder),
    new Date().toISOString(),
    id
  )
  .run();

const saved =
  await getClientByKey(
    env,
    id,
    url.origin
  );

return json(saved);

  // ACTIVATE / DEACTIVATE CLIENT
  if (
    p.startsWith("/api/clients/") &&
    request.method === "POST" &&
    p.endsWith("/status")
  ) {
    const id =
      decodeURIComponent(
        p.split("/")[3]
      );

    const d =
      await request.json();

    const active =
      d.active
        ? 1
        : 0;

    const existing =
      await env.DB
        .prepare(
          "SELECT id FROM clients WHERE id = ? OR slug = ? LIMIT 1"
        )
        .bind(id, id)
        .first();

    if (!existing) {
      return json(
        {
          error:
            "Client not found"
        },
        404
      );
    }

    await env.DB
      .prepare(
        "UPDATE clients SET active = ?, updated_at = ? WHERE id = ?"
      )
      .bind(
        active,
        new Date().toISOString(),
        existing.id
      )
      .run();

    return json({
      ok: true,
      active:
        Boolean(active)
    });
  }

  // PROFILE VIEW COUNTER
  if (
    p.startsWith("/api/clients/") &&
    request.method === "POST" &&
    p.endsWith("/view")
  ) {
    const id =
      decodeURIComponent(
        p.split("/")[3]
      );

    const existing =
      await env.DB
        .prepare(
          "SELECT id FROM clients WHERE id = ? OR slug = ? LIMIT 1"
        )
        .bind(id, id)
        .first();

    if (!existing) {
      return json(
        {
          error:
            "Profile not found"
        },
        404
      );
    }

    const now =
      new Date().toISOString();

    const result =
      await env.DB
        .prepare(
          "UPDATE clients SET view_count = COALESCE(view_count,0) + 1, last_viewed_at = ?, updated_at = ? WHERE id = ?"
        )
        .bind(
          now,
          now,
          existing.id
        )
        .run();

    const updated =
      await env.DB
        .prepare(
          "SELECT view_count FROM clients WHERE id = ?"
        )
        .bind(
          existing.id
        )
        .first();

    return json({
      ok:
        Boolean(
          result.success
        ),
      views:
        Number(
          updated?.view_count ||
          0
        )
    });
  }

  // DELETE CLIENT
  if (
    p.startsWith("/api/clients/") &&
    request.method === "DELETE"
  ) {
    const id =
      decodeURIComponent(
        p.split("/").pop()
      );

    const existing =
      await env.DB
        .prepare(
          "SELECT id, photo_key FROM clients WHERE id = ? OR slug = ? LIMIT 1"
        )
        .bind(id, id)
        .first();

    if (!existing) {
      return json(
        {
          error:
            "Client not found"
        },
        404
      );
    }

    await env.DB
      .prepare(
        "DELETE FROM clients WHERE id = ?"
      )
      .bind(
        existing.id
      )
      .run();

    return json({
      ok: true
    });
  }

  // PHOTO UPLOAD
  if (
    p === "/api/upload" &&
    request.method === "POST"
  ) {
    const form =
      await request.formData();

    const file =
      form.get("photo");

    if (!(file instanceof File)) {
      return json(
        {
          error:
            "No photo selected"
        },
        400
      );
    }

    if (
      !file.type.startsWith(
        "image/"
      )
    ) {
      return json(
        {
          error:
            "Please choose an image file."
        },
        400
      );
    }

    if (
      file.size >
      1200 * 1024
    ) {
      return json(
        {
          error:
            "Photo must be 1.2 MB or smaller."
        },
        400
      );
    }

    const bytes =
      new Uint8Array(
        await file.arrayBuffer()
      );

    let binary = "";

    const chunk =
      0x8000;

    for (
      let i = 0;
      i < bytes.length;
      i += chunk
    ) {
      binary +=
        String.fromCharCode(
          ...bytes.subarray(
            i,
            i + chunk
          )
        );
    }

    const base64 =
      btoa(binary);

    const dataUrl =
      `data:${file.type};base64,${base64}`;

    return json({
      key: dataUrl,
      url: dataUrl
    });
  }

  return json(
    {
      error:
        "API route not found"
    },
    404
  );
}

export default {
  async fetch(request, env) {
    const url =
      new URL(request.url);

    try {
      const authResponse =
        await handleAuth(
          request,
          env,
          url
        );

      if (authResponse) {
        return authResponse;
      }

      if (
        url.pathname.startsWith(
          "/api/"
        )
      ) {
        return await handleApi(
          request,
          env,
          url
        );
      }

      if (
        url.pathname === "/admin" ||
        url.pathname === "/admin/"
      ) {
        return env.ASSETS.fetch(
          new Request(
            new URL(
              "/admin/index.html",
              request.url
            ),
            request
          )
        );
      }

      if (
        url.pathname.startsWith(
          "/profile/"
        )
      ) {
        const slug =
          decodeURIComponent(
            url.pathname.slice(
              "/profile/".length
            )
          ).replace(
            /^\/+|\/+$/g,
            ""
          );

        if (!slug) {
          return Response.redirect(
            new URL(
              "/profile",
              request.url
            ),
            302
          );
        }

        const target =
          new URL(
            "/profile.html",
            request.url
          );

        target.searchParams.set(
          "slug",
          slug
        );

        return env.ASSETS.fetch(
          new Request(
            target.toString(),
            request
          )
        );
      }

      if (
        url.pathname ===
        "/profile"
      ) {
        return env.ASSETS.fetch(
          new Request(
            new URL(
              "/profile.html",
              request.url
            ),
            request
          )
        );
      }

      return env.ASSETS.fetch(
        request
      );

    } catch (err) {
      return json(
        {
          error:
            err?.message ||
            "Server error"
        },
        500
      );
    }
  }
};
