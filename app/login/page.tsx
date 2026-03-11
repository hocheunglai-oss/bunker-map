"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"

export default function LoginPage() {

  const router = useRouter()

  useEffect(() => {

    const checkUser = async () => {
      const { data } = await supabase.auth.getUser()

      if (data.user) {
        router.push("/")
      }
    }

    checkUser()

  }, [router])


  const login = async (e: any) => {
    e.preventDefault()

    const email = e.target.email.value
    const password = e.target.password.value

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password
    })

    if (!error) {
      router.push("/")
    } else {
      alert(error.message)
    }
  }


  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
      }}
    >

      <form
        onSubmit={login}
        style={{
          display: "flex",
          flexDirection: "column",
          width: "300px",
          gap: "10px"
        }}
      >

        <h2>Login</h2>

        <input
          name="email"
          placeholder="Email"
          required
        />

        <input
          name="password"
          type="password"
          placeholder="Password"
          required
        />

        <button type="submit">
          Login
        </button>

      </form>

    </div>
  )
}