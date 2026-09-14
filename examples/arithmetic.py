message = input("\nPlease enter your message: ")
try:
    x = int(input("Enter a value: "))
    y = int(input("Enter another value: "))
except ValueError:
    print("Invalid input, please try again")
else:
    print("\nLast Name, First Name")
    print(f"Message: {message}")
    print(f"Concatenation: {x + y}")
    print(f"Product = {x * y}")

    larger, smaller = (x, y) if x >= y else (y, x)
    try:
        result = larger / smaller
        if result != int(result):
            print("Error: invalid quotient")
        else:
            print(f"Quotient = {result:.0f}")
    except ZeroDivisionError:
        print("Can't divide by 0")

    print(f"Sum = {x + y}")
    print(f"Difference = {x - y}")

    print("\nMultiplication Table")
    if x == y:
        print(f"{x} and {y} are the same number")
    for i in range(1, larger + 1):
        print(f"{i} x {smaller} = {i * smaller}")
